// Attention-policy ledger — see migrations/043_attention.sql. Backs the
// dedup/cooldown check, the novelty ledger, the daily interruption budget,
// and the audit trail + outcome stamps the beliefs layer learns from. All
// reads are fail-safe (empty/zero on error) so a ledger hiccup degrades the
// policy toward its conservative defaults (no recent keys known -> treated
// as novel; budget unreadable -> treated as under budget) rather than ever
// throwing out of a watcher/nudge run.
const { query, withTransaction } = require('../db');
const { eventKey, cooldownHoursFor } = require('../intelligence/attention');

// One constant, cluster-wide advisory-lock key that serializes the WHOLE
// delivery-reservation critical section (see reserveDelivery). A single global
// lock — not a per-event_key lock — is what makes the daily/critical budget
// rechecks race-free too: two DISTINCT events competing for the last budget
// slot must serialize against each other, which a per-key lock can't do. The
// section it guards is tiny (a few COUNTs + one INSERT, no network I/O), so
// global serialization of the handful of dispatches per run is negligible.
// pg advisory locks live on the shared Postgres server, so this holds across
// every Railway replica, not just within one process. Chosen as a fixed
// 32-bit int (bigint-domain), distinct from any hashtext() key space in use.
const ATTENTION_DELIVERY_LOCK = 0x41545464; // "ATTd"
// A 'reserved' row whose finalize never ran (process crashed mid-push) must not
// hold a budget slot or block the event forever. Reservations older than this
// are treated as abandoned: not counted toward budget, not a live cooldown.
const RESERVATION_TTL_MS = Number(process.env.ATTENTION_RESERVATION_TTL_MS) || 10 * 60 * 1000;
// Retry policy: a failed push does NOT start the cooldown (recentKeys keys off
// delivered_channel, which a failed row leaves null), so the next dispatch
// cycle re-emits and re-attempts it. To stop a persistently-failing push from
// re-firing every run, retries for the same fact are capped per day; past the
// cap the event is recorded 'skipped' (retries exhausted) until the day/bucket
// rolls over — a bounded, self-resetting suppression, never a permanent one.
const MAX_DELIVERY_ATTEMPTS = Number(process.env.ATTENTION_MAX_DELIVERY_ATTEMPTS) || 3;

const SURFACED_DISPOSITIONS = ['notify_now', 'offer_action', 'auto_act'];
const BUDGET_DISPOSITIONS = ['notify_now', 'offer_action', 'auto_act'];

// The event's own title/body — the SAME copy already approved for direct
// user display (it's what a push notification would show) — persisted
// alongside the internal reason/scores/gates audit fields. Blank/whitespace-
// only counts as "no approved content" (NULL), never an empty-string card.
function approvedUserFacing(event) {
  const title = event?.title != null ? String(event.title).trim() : '';
  const body = event?.body != null ? String(event.body).trim() : '';
  return { userTitle: title || null, userDetail: body || null };
}

function insertRow(client, { event, decision, key, deliveryState, delivered, deliveredChannel, reservedAt = false }) {
  const { userTitle, userDetail } = approvedUserFacing(event);
  return client.query(
    `INSERT INTO attention_log
       (event_key, source, domain, type, subject, disposition, reason, scores, gates,
        delivered, delivered_channel, delivery_state, reserved_at, user_title, user_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,${reservedAt ? 'now()' : 'NULL'},$13,$14)
     RETURNING id`,
    [
      key, event.source, event.domain, event.type, event.subject,
      decision.disposition, decision.reason,
      JSON.stringify(decision.scores || {}), JSON.stringify(decision.gates || {}),
      delivered, deliveredChannel, deliveryState,
      userTitle, userDetail,
    ]
  ).then((r) => r.rows[0]?.id ?? null);
}

/** Persist one judged NON-PUSH decision (store_silently, update_belief,
 *  add_to_brief, ask_question, or a push disposition deferred to the brief/
 *  question channel). Push deliveries go through reserveDelivery/finalizeDelivery
 *  instead. `deliveredChannel` is the single "was this surfaced, and how" signal
 *  recentKeys keys off — a brief/question surfacing records its channel so it
 *  still counts toward that fact's cooldown; store_silently/update_belief pass
 *  null. Uses the same per-key advisory lock as store/nudges.js to keep the
 *  audit insert race-free. Returns the inserted row's id. */
async function record({ event, decision, delivered = false, deliveredChannel = null }) {
  const key = eventKey(event);
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    return insertRow(client, {
      event, decision, key,
      deliveryState: 'stored', delivered, deliveredChannel,
    });
  });
}

/**
 * Phase 1 of atomic push delivery. Inside ONE serialized transaction (the
 * single cluster-wide advisory lock above), rechecks — against committed
 * state, counting in-flight 'reserved' rows so two racers can't both grab the
 * last slot — the cooldown, the retry cap, the daily budget, and the critical
 * reserve, then either reserves a slot or records a terminal audit row.
 *
 * Returns:
 *   { proceed: true,  id }                    -> caller performs the push OUTSIDE
 *                                                the txn, then finalizeDelivery()
 *   { proceed: false, id, reason }            -> no push; an audit row is already
 *                                                written ('skipped', delivered=false)
 */
async function reserveDelivery({ event, decision, tz = process.env.TZ || 'America/New_York' }) {
  const key = eventKey(event);
  const consumesBudget = !!decision.deliver?.consumesBudget;
  const usesCriticalReserve = !!decision.deliver?.usesCriticalReserve;
  const budgetLimit = Number(process.env.ATTENTION_DAILY_BUDGET) || 4;
  const criticalLimit = Number(process.env.ATTENTION_CRITICAL_RESERVE) || 1;
  const ttl = String(RESERVATION_TTL_MS);

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ATTENTION_DELIVERY_LOCK]);

    // Cooldown recheck: a live (delivered, or still-fresh reserved) row for
    // this exact fact already claimed the surface — a concurrent racer beat us.
    const live = await client.query(
      `SELECT 1 FROM attention_log
        WHERE event_key = $1 AND delivery_state IN ('reserved','delivered')
          AND (delivery_state = 'delivered' OR reserved_at > now() - ($2 || ' milliseconds')::interval)
        LIMIT 1`,
      [key, ttl]
    );
    if (live.rowCount) {
      const id = await insertRow(client, { event, decision, key, deliveryState: 'skipped', delivered: false, deliveredChannel: null });
      return { proceed: false, id, reason: 'already reserved/delivered for this fact' };
    }

    // Retry cap: too many failed attempts for this fact today.
    const failed = await client.query(
      `SELECT count(*)::int AS n FROM attention_log
        WHERE event_key = $1 AND delivery_state = 'failed'
          AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [key, tz]
    );
    if ((failed.rows[0]?.n ?? 0) >= MAX_DELIVERY_ATTEMPTS) {
      const id = await insertRow(client, { event, decision, key, deliveryState: 'skipped', delivered: false, deliveredChannel: null });
      return { proceed: false, id, reason: 'delivery retries exhausted for this fact today' };
    }

    // Daily budget recheck — counts delivered + in-flight reserved pushes today.
    if (consumesBudget) {
      const used = await client.query(
        `SELECT count(*)::int AS n FROM attention_log
          WHERE disposition = ANY($3)
            AND delivery_state IN ('delivered','reserved')
            AND (delivery_state = 'delivered' OR reserved_at > now() - ($2 || ' milliseconds')::interval)
            AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
        [tz, ttl, BUDGET_DISPOSITIONS]
      );
      if ((used.rows[0]?.n ?? 0) >= budgetLimit) {
        const id = await insertRow(client, { event, decision, key, deliveryState: 'skipped', delivered: false, deliveredChannel: null });
        return { proceed: false, id, reason: `daily interruption budget (${budgetLimit}) exhausted at reservation` };
      }
    }

    // Critical-reserve recheck — same in-flight-aware counting.
    if (usesCriticalReserve) {
      const used = await client.query(
        `SELECT count(*)::int AS n FROM attention_log
          WHERE gates->>'critical_reserve_consumed' = 'true'
            AND delivery_state IN ('delivered','reserved')
            AND (delivery_state = 'delivered' OR reserved_at > now() - ($2 || ' milliseconds')::interval)
            AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
        [tz, ttl]
      );
      if ((used.rows[0]?.n ?? 0) >= criticalLimit) {
        const id = await insertRow(client, { event, decision, key, deliveryState: 'skipped', delivered: false, deliveredChannel: null });
        return { proceed: false, id, reason: `critical reserve (${criticalLimit}) exhausted at reservation` };
      }
    }

    // All rechecks passed -> claim the slot. The partial unique index
    // (attention_log_one_live_delivery) is a backstop; the advisory lock is the
    // primary guarantee, so this INSERT never actually races a duplicate.
    const id = await insertRow(client, {
      event, decision, key, deliveryState: 'reserved', delivered: false, deliveredChannel: null, reservedAt: true,
    });
    return { proceed: true, id };
  });
}

/** Phase 2 of atomic push delivery. Marks a reserved row's terminal state
 *  after the external push ran (or was declined). 'delivered' records the push
 *  channel (and enters the fact's cooldown via delivered_channel); 'failed'
 *  and 'skipped' leave delivered_channel null so the fact stays retry-eligible
 *  and does not start a cooldown. Best-effort: a finalize failure leaves a
 *  'reserved' row, which the RESERVATION_TTL_MS staleness guard reclaims. */
async function finalizeDelivery(id, state, { deliveredChannel = null } = {}) {
  if (id == null) return;
  const delivered = state === 'delivered';
  try {
    await query(
      `UPDATE attention_log
          SET delivery_state = $2, delivered = $3, delivered_channel = $4,
              delivery_attempts = delivery_attempts + 1
        WHERE id = $1`,
      [id, state, delivered, delivered ? (deliveredChannel || 'push') : null]
    );
  } catch (err) {
    console.error('[attention] finalizeDelivery failed:', err.message);
  }
}

/** event_key -> "surfaced to the user recently enough that the SAME fact
 *  should stay suppressed". Per-type cooldown (attention.js's
 *  COOLDOWN_HOURS_BY_TYPE), queried as one set covering the longest relevant
 *  window, then filtered per-row by that event's own type cooldown — a
 *  single query rather than N per-type queries. */
async function recentKeys({ types = null, days = 31 } = {}) {
  try {
    // "Surfaced" = the user was (or imminently will be) shown this fact through
    // SOME channel: delivered_channel is the single source of that truth. A push
    // that FAILED or was skipped leaves delivered_channel null (see
    // finalizeDelivery), so it does NOT start the cooldown — the next dispatch
    // cycle can retry it. Brief/question surfacings record their channel, so
    // they still count. This is the fix for the old bug where a transient push
    // failure suppressed the fact for its full (up to 60-day) cooldown.
    const { rows } = await query(
      `SELECT event_key, type, created_at FROM attention_log
        WHERE delivered_channel IS NOT NULL
          AND created_at >= now() - ($1 || ' days')::interval
          AND ($2::text[] IS NULL OR type = ANY($2))
        ORDER BY created_at DESC`,
      [String(days), types]
    );
    const now = Date.now();
    const keys = new Set();
    for (const r of rows) {
      if (keys.has(r.event_key)) continue; // newest row per key already checked (ORDER BY DESC)
      const hoursSince = (now - new Date(r.created_at).getTime()) / 3600000;
      if (hoursSince < cooldownHoursFor(r.type)) keys.add(r.event_key);
    }
    return keys;
  } catch {
    return new Set();
  }
}

/** How many notify_now/offer_action/auto_act rows already spent today's
 *  interruption budget. Auto_act with a 'brief' delivery channel (deferred
 *  because it was quiet) does not count — only actual interruptions do. */
async function budgetUsedToday({ tz = process.env.TZ || 'America/New_York' } = {}) {
  try {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM attention_log
        WHERE disposition IN ('notify_now','offer_action','auto_act')
          AND delivered_channel = 'push'
          AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
      [tz]
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** How many of today's critical-reserve slots are already spent. Counts only
 *  rows that ACTUALLY consumed the reserve (the bypass fired) — not every event
 *  judged critical. A critical event that fell through to normal scoring (on
 *  cooldown, or the reserve already spent) carries gates.critical_override for
 *  audit but must NOT count against the reserve it never used. */
async function criticalUsedToday({ tz = process.env.TZ || 'America/New_York' } = {}) {
  try {
    // Only count reserves that were ACTUALLY spent (delivered). A concurrent
    // racer that judged critical but lost the reservation recheck still carries
    // gates.critical_reserve_consumed (judge set it before the race resolved),
    // but its row is 'skipped' with delivered_channel null — it never consumed
    // the reserve, so it must not count here.
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM attention_log
        WHERE gates->>'critical_reserve_consumed' = 'true'
          AND delivered_channel = 'push'
          AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
      [tz]
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** event_key -> true if EVER seen before (any disposition, any time) — the
 *  raw novelty signal the policy's `novelty` score is 1 minus. */
async function everSeen(keys) {
  if (!keys || !keys.length) return new Set();
  try {
    const { rows } = await query(`SELECT DISTINCT event_key FROM attention_log WHERE event_key = ANY($1)`, [keys]);
    return new Set(rows.map((r) => r.event_key));
  } catch {
    return new Set();
  }
}

/** Stamp the outcome of a previously-logged event (dismissed/ignored/
 *  accepted/completed) — the input the beliefs layer's outcome-feedback
 *  promoter reads. Matches the most recent row for this event_key. */
async function stampOutcome(event, outcome) {
  const key = eventKey(event);
  try {
    await query(
      `UPDATE attention_log SET outcome = $2, outcome_at = now()
        WHERE id = (SELECT id FROM attention_log WHERE event_key = $1 AND outcome IS NULL ORDER BY created_at DESC LIMIT 1)`,
      [key, outcome]
    );
  } catch { /* best-effort — outcome stamping must never break a caller's own flow */ }
}

/** Aggregate recent outcomes per (domain, type, subject) — feeds
 *  beliefs.js's dismissal/ignore-pattern promotion the same way
 *  dismissalPatterns() reads store/dismissedInsights.js today. */
async function outcomeCounts({ days = 30 } = {}) {
  try {
    const { rows } = await query(
      `SELECT domain, type, subject, outcome, count(*)::int AS n
         FROM attention_log
        WHERE outcome IS NOT NULL AND outcome_at >= now() - ($1 || ' days')::interval
        GROUP BY domain, type, subject, outcome`,
      [String(days)]
    );
    return rows;
  } catch {
    return [];
  }
}

/** Today's add_to_brief / ask_question rows — what the next briefing build
 *  should consider surfacing (routes/briefing.js's consumer). */
/**
 * `since` (optional Date) narrows to rows strictly AFTER that instant — the
 * Today command-center's "Since This Morning" addenda reuses this SAME
 * ledger with `since: snapshotAt` so a mutation the morning snapshot already
 * reflects is never re-surfaced as new, and only a genuinely post-snapshot
 * event appears (truth-and-evidence contract: no second event system, no
 * mobile-side derivation of what counts as "new"). Omitting `since` keeps the
 * original today-only behavior used to feed the chief-brief prompt.
 */
async function pendingForBrief({ tz = process.env.TZ || 'America/New_York', limit = 8, since = null } = {}) {
  try {
    const params = [tz, limit];
    let sinceClause = '';
    if (since) {
      params.push(new Date(since));
      sinceClause = `AND created_at > $${params.length}`;
    }
    const { rows } = await query(
      `SELECT event_key, domain, type, subject, disposition, reason, scores, created_at
         FROM attention_log
        WHERE disposition IN ('add_to_brief','ask_question')
          AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
          ${sinceClause}
        ORDER BY (scores->>'value')::float DESC NULLS LAST
        LIMIT $2`,
      params
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * User-visible post-snapshot changes for Today's "Since This Morning" card —
 * a NARROWLY NAMED SIBLING to pendingForBrief(), not a reuse of it (see the
 * "Since This Morning" leak fix). pendingForBrief() feeds the chief-brief
 * LLM PROMPT as raw context the model is instructed to interpret/reword —
 * that stays exactly as-is (the chief-brief pipeline's `reason` usage is a
 * safe, internal, LLM-mediated use, not a raw UI render). This function
 * feeds an actual UI surface directly, so it is strict about what leaves the
 * ledger:
 *   - only rows carrying BOTH user_title and user_detail — the event's own
 *     already-approved-for-display copy (see insertRow's approvedUserFacing);
 *     a row with only the internal `reason` audit string is excluded, not
 *     downgraded into prose here — "fix the data contract, not the string."
 *   - never a commitment_due row: commitment completion is an audit/belief
 *     signal (routes/commitments.js's stampCommitmentOutcome) already
 *     reflected in the commitments UI itself, not a second Since-This-
 *     Morning addendum. (Structurally these are always disposition
 *     'notify_now' today, which the disposition filter below already
 *     excludes — this is a second, explicit guard against that ever
 *     changing silently.)
 *   - `since` is compared against created_at ONLY — never outcome_at — so a
 *     completion/outcome stamp on an OLDER row (which updates outcome_at,
 *     never created_at) can never make that older event look newly-occurred.
 */
async function sinceMorningForUser({ since, limit = 8 } = {}) {
  if (!since) return [];
  try {
    const { rows } = await query(
      `SELECT event_key, domain, type, subject, user_title, user_detail, created_at
         FROM attention_log
        WHERE disposition IN ('add_to_brief','ask_question')
          AND type != 'commitment_due'
          AND user_title IS NOT NULL AND user_detail IS NOT NULL
          AND created_at > $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [new Date(since), limit]
    );
    return rows;
  } catch {
    return [];
  }
}

module.exports = {
  record, reserveDelivery, finalizeDelivery,
  recentKeys, budgetUsedToday, criticalUsedToday, everSeen, stampOutcome, outcomeCounts, pendingForBrief,
  sinceMorningForUser,
  ATTENTION_DELIVERY_LOCK, RESERVATION_TTL_MS, MAX_DELIVERY_ATTEMPTS,
};
