// Morning briefing pre-build + push. Runs on the scheduler (~8am): forces a
// fresh briefing build so the cache is warm when you open the app (no 15-40s
// wait), then sends a "Your morning briefing is ready!" push to your devices.
//
// We warm the cache by calling buildFreshBriefing() directly — the exact same
// function GET /api/briefing itself calls — so there's no duplicate briefing
// logic to drift. This used to go over a loopback HTTP call to our own
// /api/briefing?refresh=1, an unnecessary network hop (and failure mode) for
// what is, underneath, a same-process function call.
const devicesStore = require('../store/devices');
// Call through the module object (not a destructured `const { sendPush }`) so
// a caller that stubs expo.sendPush (tests) — or a future hot-reload — is
// picked up; a destructured reference would stay bound to whatever sendPush
// was AT REQUIRE TIME. Same lesson already applied in notify/dispatch.js.
const expo = require('./expo');

// Bug: BRIEFING_FRESH_SKIP_MS's rolling window (default 2h) meant an 8:03am
// manual build stopped suppressing the automatic trigger by 10:03am — an
// 11:33am scheduler/cron/watcher/Eight-Sleep-triggered run would rebuild AND
// re-announce "Good morning" a second time the SAME day. Replaced with local-
// calendar-day semantics: any VALID daily briefing already built today (in
// the user's timezone), by ANY trigger (manual or automatic), suppresses
// every later automatic trigger for the rest of that day — no rolling window
// to age out of. "Valid" excludes a failed/incomplete build (no chiefBrief at
// all, fresh or carried-forward) so a broken manual attempt doesn't block the
// scheduled build from ever happening.
//
// Audit fix: "valid" (a non-null chiefBrief) used to be the ONLY bar — but a
// degraded automatic build (a claim-validator grounded-fallback sentence, or
// an underfilled response — see brain/claimValidator.js's
// assessChiefBriefQuality) has a non-null chiefBrief too. Treating that as
// "today is done" is exactly the bug where the first automatic brief is a
// bare "Recovery is green at 100 today." and nothing ever retries it.
// Two separate predicates now exist for two separate questions:
//   - hasDisplayableBriefToday: is there SOMETHING to show today (may be
//     degraded) — used to decide whether a manual rebuild has ANY card to
//     carry forward if this build fails.
//   - hasPublishableFreshBriefToday: was today's brief actually a GOOD build
//     — the only thing allowed to suppress the automatic morning routine,
//     burn the once-a-day push, or skip a bounded retry.

/** Local calendar-day string (YYYY-MM-DD) in the given timezone. */
function localDay(d, tz = process.env.TZ || 'America/New_York') {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

function sameLocalDayAsNow(latest, { now = new Date(), tz = process.env.TZ || 'America/New_York' } = {}) {
  if (!latest?.generated_at) return false;
  const t = new Date(latest.generated_at);
  if (Number.isNaN(t.getTime())) return false;
  return localDay(t, tz) === localDay(now, tz);
}

/**
 * Pure: does `latest` (a { generated_at, content } row from briefings) have
 * ANY brief to show for today — same local calendar day AND a non-null
 * chiefBrief (which may be degraded/carried-forward, not necessarily fresh)?
 * @param {{ generated_at: string|Date, content?: { chiefBrief?: any } }|null} latest
 * @param {{ now?: Date, tz?: string }} [opts]
 */
function hasDisplayableBriefToday(latest, opts = {}) {
  if (!sameLocalDayAsNow(latest, opts)) return false;
  return latest.content?.chiefBrief != null;
}

/**
 * Pure: was today's brief a GOOD build — same local calendar day, a real
 * chiefBrief, AND (per brain/claimValidator.js's assessChiefBriefQuality)
 * quality status 'fresh', not 'degraded' or 'failed'? Rows saved before this
 * quality contract existed carry no chiefBriefQuality at all — treated as
 * fresh for backward compatibility (they predate the contract, not the bar).
 * THIS is the only predicate allowed to suppress the automatic morning
 * routine, burn the once-a-day "ready" push, or skip a bounded retry.
 * @param {{ generated_at: string|Date, content?: { chiefBrief?: any, chiefBriefQuality?: { status?: string } } }|null} latest
 * @param {{ now?: Date, tz?: string }} [opts]
 */
function hasPublishableFreshBriefToday(latest, opts = {}) {
  if (!hasDisplayableBriefToday(latest, opts)) return false;
  const quality = latest.content?.chiefBriefQuality;
  return quality == null || quality.status === 'fresh';
}

/** The newest daily briefing row ({ generated_at, content, ... }), or null. */
async function latestDailyBriefing() {
  try {
    const rows = await require('../store/briefings').listBriefings({ kind: 'daily', limit: 1 });
    return rows[0] ?? null;
  } catch (e) {
    console.error('[morning] freshness lookup failed (proceeding):', e.message);
    return null; // on error, don't suppress — better a rare dup than a missed brief
  }
}

/** Force a fresh briefing build so the app opens to a ready briefing.
 *  publish=false returns an unpublished DRAFT (see buildFreshBriefing/
 *  publishBriefingDraft in routes/briefing.js) — nothing is persisted,
 *  TTS-prewarmed, or handed to the next-build-cycle priming until the caller
 *  explicitly publishes it. Used by the automatic morning path so a final
 *  readiness + quality check can run against the exact draft before anything
 *  ships. */
async function warmBriefing({ publish = true } = {}) {
  const { buildFreshBriefing } = require('../routes/briefing');
  return buildFreshBriefing({ force: true, publish });
}

// Duplicated from scheduler.js's identical helper (not required FROM it) —
// scheduler.js already requires this module, so requiring scheduler.js back
// here would be a cycle.
function eightSleepConfigured() {
  return Boolean(process.env.EIGHT_SLEEP_EMAIL && process.env.EIGHT_SLEEP_PASSWORD);
}

/**
 * Re-run the authoritative sleep-readiness gate one more time, immediately
 * before publishing a prepared draft — closes the race where the user
 * returns to bed (or a new interval/fingerprint appears) while the
 * expensive analyze()/Opus build was still running. The earlier gates
 * (scheduler.js's pre-ingest check + revalidate-after-ingest check) both run
 * BEFORE that expensive work; this is the third, FINAL check, against
 * whatever the world looks like right as we're about to publish. A no-op
 * pass-through when Eight Sleep isn't configured — there's nothing to gate.
 */
async function finalMorningGate({ asOf = new Date() } = {}) {
  if (!eightSleepConfigured()) return { ready: true, reason: 'not_configured' };
  const readiness = require('../intelligence/sleep-readiness');
  const result = await readiness.getMorningSleepReadiness({ asOf, trigger: 'final_gate' });
  console.log(readiness.readinessLogLine(result));
  return result;
}

/** Local-day dedup key for the "Good morning" push — ONE brief-ready ping per
 *  day, total, across every trigger (watcher, external cron, sleep check-in).
 *  The content can rebuild as often as it likes; the push cannot repeat. */
function morningPushKey(d = new Date()) {
  const tz = process.env.TZ || 'America/New_York';
  return `morning_brief_push:${d.toLocaleDateString('en-CA', { timeZone: tz })}`;
}

/**
 * Structured, single-line, correlated lifecycle log for the morning
 * publish/push pipeline (item F). `buildId`/`snapshotId` are the join keys a
 * mobile-side log line (useBriefing.ts's openFromPush) stamps too — so the
 * backend half (publish/readback/push) and the mobile half (tap/exact-fetch)
 * of one morning's story can be correlated across both log streams without a
 * new telemetry endpoint. Deliberately never logs private briefing text.
 */
function logMorningLifecycle(fields = {}) {
  console.log('[morning:lifecycle]', JSON.stringify({
    buildId: fields.buildId ?? null,
    trigger: fields.trigger ?? null,
    localDay: fields.localDay ?? null,
    briefingId: fields.briefingId ?? null,
    snapshotId: fields.snapshotId ?? null,
    quality: fields.quality ?? null,
    publishStarted: Boolean(fields.publishStarted),
    publishSucceeded: Boolean(fields.publishSucceeded),
    readbackVerified: Boolean(fields.readbackVerified),
    pushSent: Boolean(fields.pushSent),
    failureReason: fields.failureReason ?? null,
  }));
}

/** Send the "Good morning" ready push for a VERIFIED publication `receipt`
 *  (see publishBriefingDraft — never an in-memory draft treated as its own
 *  proof), honoring the once-per-day dedup key. `content` is the same
 *  attempt's full response object, read ONLY for cosmetic body text (e.g.
 *  weather) — never for identifiers, which come exclusively from `receipt`.
 *  Shared tail of warmAndNotify's two paths (automatic-published-fresh and
 *  manual/forced). */
async function sendReadyPush(receipt, content, quality) {
  const nudgesStore = require('../store/nudges');
  try {
    const recent = await nudgesStore.recentlySentKeys(1);
    if (recent.has(morningPushKey())) {
      console.log('[morning] brief-ready push already sent today — rebuilt content, skipping duplicate push');
      return { built: true, sent: 0, skipped: 'already_pushed_today', quality };
    }
  } catch (e) {
    console.error('[morning] push-dedup check failed (proceeding):', e.message);
  }

  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { built: true, sent: 0, reason: 'no_devices', quality };

  // A touch of useful context in the body when we have it (e.g. weather/date)
  // — cosmetic only, read from the unverified content, never from `receipt`.
  let body = 'Your morning briefing is ready — tap to start your day.';
  try {
    const t = content?.weather?.temp;
    const cond = content?.weather?.condition;
    if (t != null && cond) body = `Your morning briefing is ready — ${Math.round(t)}° and ${String(cond).toLowerCase()}. Tap to start your day.`;
  } catch { /* keep default */ }

  try {
    const r = await expo.sendPush(tokens, {
      title: 'Good morning ☀️',
      body,
      // Every identifier here comes from the VERIFIED receipt (item A) — the
      // mobile client resolves this EXACT persisted row via
      // GET /briefing/by-snapshot/:snapshotId, never a generic reload.
      data: {
        type: 'morning_briefing',
        briefingId: receipt?.briefingId ?? null,
        snapshotId: receipt?.snapshotId ?? null,
        snapshotVersion: receipt?.snapshotVersion ?? null,
        localDay: receipt?.localDay ?? null,
        builtAt: receipt?.builtAt ?? null,
      },
    });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    // Record the once-per-day key only after the push actually went out, so a
    // failed send doesn't burn the day's one allowed ping.
    if (r.sent > 0) {
      try {
        const id = await nudgesStore.recordNudge({
          dedupKey: morningPushKey(),
          title: 'Good morning ☀️',
          body,
          basis: { type: 'morning_brief_push' },
          status: 'pending',
        });
        if (id != null) await nudgesStore.markStatus(id, 'sent');
      } catch (e) {
        console.error('[morning] push-dedup record failed:', e.message);
      }
    }
    return { built: true, sent: r.sent, quality, receipt };
  } catch (err) {
    console.error('[morning] push failed:', err.message);
    return { built: true, sent: 0, error: err.message, quality, receipt };
  }
}

/**
 * Build the briefing and push the "ready" notification. Shared by the morning
 * routine AND the sleep check-in (which triggers it after you log).
 *
 * `opts.automatic` (set by runMorningRoutineUnguarded for every non-forced
 * call) routes this through the prepare -> validate -> publish lifecycle:
 * the briefing is built as an UNPUBLISHED draft, a final readiness re-check
 * runs against that exact draft, and the draft is published only if BOTH
 * that re-check AND the quality gate below still pass.
 *
 * Fresh-before-publish invariant (audit fix — a degraded automatic draft
 * used to be published anyway "so there's something to show", which is
 * exactly the production bug: the app showed brain/claimValidator.js's
 * deterministic grounded-fallback sentence — "Recovery is green at NN
 * today." — as if it were a completed brief, and nothing ever visibly
 * retried it since a non-null chiefBrief already looked "done"). Now:
 *   - A final-readiness failure discards the draft entirely — no visible
 *     daily briefing, no TTS prewarm, no "ready" push, no morning marker
 *     (the caller sees built:false, skipped:'final_gate_failed').
 *   - A degraded/failed QUALITY draft is likewise discarded — NEVER
 *     published, saved, TTS-prewarmed, or pushed (built:false,
 *     skipped:'quality_not_fresh', quality:<status>). The existing fresh
 *     Chief Brief (if any) already on `briefings` is left completely
 *     untouched — this function never even attempts to save over it.
 *   - Only a FRESH draft is published and (if `send`) triggers the "ready"
 *     push. `quality` is always reported so the caller (scheduler.js) can
 *     record a bounded retry attempt instead of burning the once-a-day
 *     morning marker.
 * `opts.force` (manual authenticated diagnostics only) bypasses all of this,
 * exactly as before: eager build, eager publish, eager push.
 */
async function warmAndNotify(opts = {}) {
  const send = opts.send !== false;
  const automatic = opts.automatic === true && opts.force !== true;
  const tz = process.env.TZ || 'America/New_York';
  const buildJobs = require('../store/morningBuildJobs');

  // opts.force (authenticated manual/diagnostic testing ONLY) is the one
  // deliberate bypass of the quality gate below — eager build, eager
  // publish, eager push, exactly as before. Every OTHER caller — automatic
  // or manual/explicit, per the audit fix's "this exact quality gate must
  // apply to... manual full rebuilds" requirement — goes through the SAME
  // prepare -> validate -> publish lifecycle just below, differing only in
  // whether the final sleep-readiness re-check (automatic-only) also runs.
  if (opts.force === true) {
    let built = false;
    let briefing = null;
    try {
      briefing = await warmBriefing();
      built = true;
    } catch (err) {
      console.error('[morning] briefing warm failed:', err.message);
    }
    const quality = briefing?.chiefBriefQuality?.status ?? null;
    const receipt = briefing?.publicationReceipt ?? null;
    const logBase = {
      trigger: opts.trigger || 'manual_force', quality,
      briefingId: receipt?.briefingId, snapshotId: receipt?.snapshotId, localDay: receipt?.localDay,
      publishStarted: built, publishSucceeded: Boolean(receipt), readbackVerified: Boolean(receipt?.readbackVerified),
    };
    if (!send) { logMorningLifecycle({ ...logBase, pushSent: false }); return { built, sent: 0, quality }; }
    if (!built) { logMorningLifecycle({ ...logBase, pushSent: false, failureReason: 'warm_failed' }); return { built, sent: 0, quality }; }
    // A fresh attempt whose OWN publish didn't produce a verified receipt
    // (persistence failure, or read-back mismatch) must never be pushed —
    // "built" here only ever meant "the generation call didn't throw", not
    // "there's a verified row to reference."
    if (!receipt) {
      console.error('[morning] force build did not produce a verified publication receipt — NOT sending push.');
      logMorningLifecycle({ ...logBase, pushSent: false, failureReason: 'publish_not_verified' });
      return { built: false, sent: 0, skipped: 'publish_failed', quality };
    }
    const result = await sendReadyPush(receipt, briefing, quality);
    logMorningLifecycle({ ...logBase, pushSent: (result.sent ?? 0) > 0, failureReason: result.error ?? null });
    return result;
  }

  // ── unify automatic builds through the same durable job ledger the manual
  // rebuild endpoint already uses (item D) — the mobile status poll must
  // never see "no job" for an automatic attempt that actually ran. Each
  // automatic call is its own attempt row; "ready" is set ONLY after
  // publishBriefingDraft's read-back verification succeeds below, never
  // merely because generation or the INSERT returned.
  let job = null;
  const day = buildJobs.localDay(new Date(), tz);
  if (automatic) {
    try {
      const attemptNumber = (await buildJobs.attemptsToday(day, tz)) + 1;
      job = await buildJobs.createJob({ trigger: opts.trigger || 'scheduled', state: 'building', attemptNumber, localDay: day, tz });
    } catch (err) {
      console.error('[morning] failed to create automatic build-job row (continuing without one):', err.message);
    }
  }
  const failJob = (errorMessage, extra = {}) => {
    if (!job) return Promise.resolve();
    return buildJobs.updateJob(job.id, { state: 'failed', errorMessage, ...extra }).catch((e) => console.error('[morning] job update failed:', e.message));
  };

  // ── prepare -> validate -> publish (audit fix, items 3+4) ───────────────
  let draft = null;
  try {
    draft = await warmBriefing({ publish: false });
  } catch (err) {
    console.error('[morning] briefing draft build failed:', err.message);
    await failJob(`draft_build_failed: ${err.message}`);
    logMorningLifecycle({ buildId: job?.id, trigger: opts.trigger, localDay: day, publishStarted: false, failureReason: 'draft_build_failed' });
    return { built: false, sent: 0, skipped: 'draft_build_failed', quality: null };
  }

  // Final readiness re-check only applies to the AUTOMATIC trigger (closes
  // the race where the user returns to bed while the expensive build ran) —
  // a manual/explicit rebuild is the user asking right now; there is nothing
  // to re-gate on sleep timing for that case, only on content quality below.
  if (automatic) {
    const gate = await finalMorningGate();
    if (!gate.ready) {
      console.log(`[morning] final readiness gate failed after preparing the draft (${gate.reason}) — discarding the draft; nothing published.`);
      await failJob(`final_gate_failed: ${gate.reason}`);
      logMorningLifecycle({ buildId: job?.id, trigger: opts.trigger, localDay: day, publishStarted: false, failureReason: 'final_gate_failed' });
      return { built: false, sent: 0, skipped: 'final_gate_failed', reason: gate.reason, quality: null };
    }
  }

  // Fresh-before-publish invariant (audit fix): a draft the system already
  // knows is degraded/failed (brain/claimValidator.js's assessChiefBriefQuality)
  // must NEVER be published, TTS-prewarmed, or pushed — publishBriefingDraft
  // persists the row (store/briefings.js), and Postgres has no readable
  // "draft" state once that INSERT lands: every reader (GET /api/briefing,
  // the app's cache-hit path, the morning push) would see it immediately.
  // The ONLY safe gate is checking quality BEFORE that call, not saving and
  // then trying to hide/delete a bad row after the fact. Nothing here is
  // persisted for a non-fresh draft — the retry ledger (scheduler.js) is what
  // paces the next automatic attempt; a manual caller sees this reflected in
  // its build-job status instead (routes/briefing.js's build-job contract).
  const quality = draft?.chiefBriefQuality?.status ?? null;
  if (quality !== 'fresh') {
    console.log(`[morning] draft quality is ${quality || 'unknown'} — NOT publishing (never saved, never TTS-prewarmed, never pushed); a bounded retry can run later.`);
    await failJob('quality_not_fresh', { qualityStatus: quality, snapshotId: draft?.snapshotId ?? null, reasonCodes: draft?.chiefBriefQuality?.reasonCodes ?? [] });
    logMorningLifecycle({ buildId: job?.id, trigger: opts.trigger, localDay: day, quality, publishStarted: false, failureReason: 'quality_not_fresh' });
    return { built: false, sent: 0, skipped: 'quality_not_fresh', quality };
  }

  const { publishBriefingDraft } = require('../routes/briefing');
  let receipt;
  try {
    receipt = await publishBriefingDraft(draft);
  } catch (err) {
    // Persistence/read-back failure (audit fix, item 4; morning-notification
    // lifecycle fix, item A): a fresh draft that failed to SAVE — or whose
    // post-save read-back didn't verify — must not be treated as published —
    // no push, no morning-complete marker (scheduler.js only marks the day
    // done when built===true AND quality==='fresh', both of which this
    // response now correctly denies), and the job stays retryable ('failed',
    // never 'ready').
    console.error('[morning] publish failed — NOT sending push, NOT marking the day done:', err.message);
    await failJob(err.message, { qualityStatus: quality, snapshotId: draft?.snapshotId ?? null });
    logMorningLifecycle({ buildId: job?.id, trigger: opts.trigger, localDay: day, quality, snapshotId: draft?.snapshotId, publishStarted: true, publishSucceeded: false, readbackVerified: false, failureReason: err.message });
    return { built: false, sent: 0, skipped: 'publish_failed', quality };
  }

  // Only NOW — after the read-back verification inside publishBriefingDraft
  // has proven the exact row is retrievable and publishable — may the job
  // become "ready". This is what "ready" means: not that generation or the
  // INSERT returned, but that the persisted row passed verification.
  if (job) {
    await buildJobs.updateJob(job.id, {
      state: 'ready', qualityStatus: receipt.qualityStatus, snapshotId: receipt.snapshotId, publishedBriefingId: receipt.briefingId,
    }).catch((err) => console.error('[morning] job update failed:', err.message));
  }

  if (!send) {
    logMorningLifecycle({
      buildId: job?.id, trigger: opts.trigger, localDay: receipt.localDay, briefingId: receipt.briefingId, snapshotId: receipt.snapshotId,
      quality, publishStarted: true, publishSucceeded: true, readbackVerified: true, pushSent: false,
    });
    return { built: true, sent: 0, quality };
  }
  const result = await sendReadyPush(receipt, draft, quality);
  logMorningLifecycle({
    buildId: job?.id, trigger: opts.trigger, localDay: receipt.localDay, briefingId: receipt.briefingId, snapshotId: receipt.snapshotId,
    quality, publishStarted: true, publishSucceeded: true, readbackVerified: true,
    pushSent: (result.sent ?? 0) > 0, failureReason: result.error ?? result.skipped ?? null,
  });
  return result;
}

/** Push the "log your sleep" prompt (no brief is built — it waits for the log). */
async function pushSleepCheckIn(opts = {}) {
  if (opts.send === false) return { built: false, sleepCheckIn: true, sent: 0 };
  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { built: false, sleepCheckIn: true, sent: 0, reason: 'no_devices' };
  try {
    const r = await expo.sendPush(tokens, {
      title: 'How did you sleep? 🛌',
      body: 'No Eight Sleep reading last night — log your sleep and I’ll build your brief with a recovery score.',
      data: { type: 'sleep_checkin' },
    });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    return { built: false, sleepCheckIn: true, sent: r.sent };
  } catch (err) {
    console.error('[morning] sleep check-in push failed:', err.message);
    return { built: false, sleepCheckIn: true, sent: 0, error: err.message };
  }
}

/**
 * Morning routine. On nights with no Eight Sleep reading, DON'T build a brief on
 * empty recovery — push the sleep check-in instead, and the brief builds itself
 * when the user logs (POST /api/recovery/self-report → warmAndNotify). Otherwise
 * pre-build the briefing and push "ready".
 *
 * Race-safe against a concurrent manual build: shares routes/briefing.js's
 * REBUILD_LOCK_ID Postgres advisory lock with POST /briefing/rebuild (the
 * app's "Rebuild" button) and GET /api/briefing?refresh=1. Whichever caller
 * wins the lock proceeds; the other sees it held and skips cleanly instead of
 * racing to a second concurrent build/push. The lock only guards the DECISION
 * + build window, not background ingestion, which still runs and updates
 * fields silently as it always has.
 * @param {{ send?: boolean, force?: boolean }} [opts]
 */
async function runMorningBriefing(opts = {}) {
  if (opts.force === true) return runMorningRoutineUnguarded(opts);

  // Fast pre-check with no DB connection held — covers the common case (a
  // brief already visibly exists for today) without any locking overhead.
  // hasPublishableFreshBriefToday (NOT hasDisplayableBriefToday) is the bar —
  // a degraded automatic attempt must not suppress today's later retry.
  const latest = await latestDailyBriefing();
  if (hasPublishableFreshBriefToday(latest)) {
    console.log(`[morning] a fresh briefing was already published today (${latest.generated_at}) — skipping automatic rebuild + push`);
    return { built: false, sent: 0, skipped: 'already_built_today' };
  }

  const REBUILD_LOCK_ID = require('../routes/briefing').REBUILD_LOCK_ID;
  const client = await require('../db').pool.connect();
  let acquired = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
    acquired = rows[0].acquired;
    if (!acquired) {
      console.log('[morning] a rebuild is already in progress (manual or automatic) — skipping this automatic trigger');
      return { built: false, sent: 0, skipped: 'rebuild_in_progress' };
    }
    // Re-check now that we hold the lock: a manual build may have landed
    // between the pre-check above and acquiring the lock, or we may have
    // just waited out a build that finished satisfying today's brief.
    const latest2 = await latestDailyBriefing();
    if (hasPublishableFreshBriefToday(latest2)) {
      return { built: false, sent: 0, skipped: 'already_built_today' };
    }
    return await runMorningRoutineUnguarded(opts);
  } finally {
    if (acquired) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]); } catch { /* connection may already be gone */ }
    }
    try { client.release(); } catch { /* already released */ }
  }
}

/** The actual sleep-check-in-or-build decision, once the freshness/lock guard
 *  has cleared. `automatic` marks every call reaching this point through the
 *  normal (non-force) path — it routes warmAndNotify through the prepare ->
 *  validate -> publish lifecycle rather than the eager manual/diagnostic
 *  path. opts.force (already handled by the caller, kept here too for the
 *  rare direct call) always takes the eager path regardless. */
async function runMorningRoutineUnguarded(opts) {
  try {
    const needs = await require('../intelligence/recovery').needsSleepCheckIn();
    if (needs) return await pushSleepCheckIn(opts);
  } catch (err) {
    console.error('[morning] sleep check-in check failed:', err.message);
    // fall through to the normal briefing build
  }
  const automatic = opts.force !== true;
  return warmAndNotify({ ...opts, automatic });
}

/**
 * Generate the weekly review and push a "your weekly review is ready" notice.
 * Run on the Sunday-morning schedule. Best-effort push.
 * @param {{ send?: boolean }} [opts]
 */
async function runWeeklyReviewWithPush(opts = {}) {
  const send = opts.send !== false;
  const { runReview } = require('../intelligence/review');

  let review = null;
  try {
    review = await runReview(); // generates + persists the weekly review
  } catch (err) {
    console.error('[weekly] review generation failed:', err.message);
    return { generated: false, sent: 0, error: err.message };
  }

  if (!send) return { generated: true, sent: 0 };

  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { generated: true, sent: 0, reason: 'no_devices' };

  // Use the review headline as the notification body when we have one.
  const body = review?.headline
    ? `${review.headline} — tap to read your weekly review.`
    : 'Your weekly review is ready — see how the week went and what to focus on.';

  try {
    const r = await expo.sendPush(tokens, {
      title: 'Your weekly review is ready 📊',
      body,
      data: { type: 'weekly_review' },
    });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    return { generated: true, sent: r.sent };
  } catch (err) {
    console.error('[weekly] push failed:', err.message);
    return { generated: true, sent: 0, error: err.message };
  }
}

module.exports = {
  runMorningBriefing, warmBriefing, warmAndNotify, pushSleepCheckIn, runWeeklyReviewWithPush,
  hasDisplayableBriefToday, hasPublishableFreshBriefToday, latestDailyBriefing, finalMorningGate,
};
