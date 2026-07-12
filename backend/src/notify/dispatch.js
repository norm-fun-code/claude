// The Attention Policy's single dispatch point. Producers (watchers, the
// finding-driven nudge builder, wealth nudges, check-in reminders) call
// dispatchEvent() with a normalized event instead of deciding for themselves
// whether/how to interrupt the user. This is the ONLY place that assembles a
// PolicyContext, calls the pure judge(), and executes the resulting
// disposition — delivery (push), ledger writes, and DB reads all live here so
// intelligence/attention.js stays pure and unit-testable without a database.
const attentionStore = require('../store/attention');
const consentStore = require('../store/consent');
const devicesStore = require('../store/devices');
const nudgesStore = require('../store/nudges');
// Imported as a module object (not destructured) so tests can stub
// expo.sendPush without the captured reference going stale.
const expo = require('./expo');
const { judge, eventKey } = require('../intelligence/attention');
const { withinQuietHours } = require('../intelligence/nudges');

const DEFAULT_DAILY_BUDGET = Number(process.env.ATTENTION_DAILY_BUDGET) || 4;
const DEFAULT_CRITICAL_RESERVE = Number(process.env.ATTENTION_CRITICAL_RESERVE) || 1;

/**
 * Assemble the PolicyContext judge() needs. One DB round-trip set per
 * dispatch call — callers processing several events in one run (e.g.
 * runNudges' several candidates) should prefer dispatchEvents() (plural,
 * below) so the context is built ONCE and budget usage is tracked live
 * across the batch, not re-read stale for every candidate.
 */
async function buildContext(overrides = {}) {
  const asOf = overrides.asOf || new Date();
  const [recentKeys, usedToday, criticalUsed, consentGrants] = await Promise.all([
    attentionStore.recentKeys(),
    attentionStore.budgetUsedToday(),
    attentionStore.criticalUsedToday(),
    consentStore.activeGrants(),
  ]);

  let beliefMultipliers = new Map();
  try {
    beliefMultipliers = await require('../intelligence/beliefs').beliefMultipliers();
  } catch { /* beliefs layer unavailable -> no personalization this run, not fatal */ }

  return {
    quiet: overrides.force ? false : withinQuietHours(asOf),
    budget: { limit: DEFAULT_DAILY_BUDGET, usedToday },
    criticalBudget: { limit: DEFAULT_CRITICAL_RESERVE, usedToday: criticalUsed },
    recentKeys,
    noveltyByKey: recentKeys, // event_keys seen recently double as "not novel" for THIS context build
    consentGrants,
    beliefMultipliers,
    activeGoalSubjects: overrides.activeGoalSubjects || new Set(),
    activeChapterSubjects: overrides.activeChapterSubjects || new Set(),
    openCommitmentSubjects: overrides.openCommitmentSubjects || new Set(),
    capacity: overrides.capacity || null,
    questionBudgetLeft: overrides.questionBudgetLeft ?? 1,
  };
}

/** Execute a Decision: write the ledger row, and for a push-eligible
 *  disposition, actually send. Critical events that bypass the budget still
 *  respect quiet hours' PUSH mechanics (a push is a push) but skip the
 *  budget gate — judge() already encoded that via deliver.consumesBudget.
 *
 *  A push ALSO writes to the pre-existing `nudges` table (store/nudges.js),
 *  not just the new `attention_log` — GET /api/nudges (the mobile app's
 *  "recent proactive messages" log) reads `nudges` directly, and several
 *  not-yet-migrated surfaces (evening brief, morning routine, the scheduler's
 *  own markers) still write there too. attention_log is the policy's OWN
 *  decision/dedup/budget ledger; `nudges` stays the shared delivery log so
 *  existing consumers keep working unchanged during this incremental migration.
 */
async function execute(event, decision, { send = true } = {}) {
  const channel = decision.deliver?.channel ?? null;
  const wantsPush = channel === 'push';
  const key = eventKey(event);

  // Non-push disposition (store_silently, update_belief, add_to_brief,
  // ask_question, or a push disposition deferred to the brief/question channel
  // by quiet hours). No delivery, no budget spend — just the audit row, tagged
  // with the surfacing channel so brief/question entries still count toward the
  // fact's cooldown (store_silently/update_belief pass null and don't).
  if (!wantsPush) {
    const id = await attentionStore.record({ event, decision, delivered: false, deliveredChannel: channel });
    return { id, delivered: false, decision };
  }

  const nudgeBasis = { type: event.type, source: event.source, domain: event.domain, subject: event.subject };
  const nudgePriority = decision.scores?.value ?? 0.5;

  // Dry run: NEVER reserve a slot or touch the budget. Preserve the legacy
  // behavior of recording what WOULD have gone out (`nudges` row 'pending')
  // plus a budget-neutral audit row (delivery_state 'stored', delivered=false),
  // so a --dry-run caller inspecting either table sees the intended send.
  if (!send) {
    await nudgesStore.recordNudge({ dedupKey: key, title: event.title, body: event.body, priority: nudgePriority, basis: nudgeBasis, status: 'pending' });
    const id = await attentionStore.record({ event, decision, delivered: false, deliveredChannel: null });
    return { id, delivered: false, decision };
  }

  // Real push: reserve atomically (Phase 1), deliver OUTSIDE any DB txn, then
  // finalize the reservation (Phase 2). This is the whole point of the change —
  // the cooldown/budget/critical rechecks and the slot claim happen together
  // under one cluster-wide lock, so concurrent dispatchers can't double-send or
  // overshoot the budget.
  const reservation = await attentionStore.reserveDelivery({ event, decision });
  if (!reservation.proceed) {
    // Lost a recheck (cooldown / daily budget / critical reserve / retry cap).
    // Record a `nudges` row reflecting the non-delivery so GET /api/nudges stays
    // consistent with the ledger.
    await nudgesStore.recordNudge({ dedupKey: key, title: event.title, body: event.body, priority: nudgePriority, basis: nudgeBasis, status: 'skipped' });
    return { id: reservation.id, delivered: false, decision, skippedReason: reservation.reason };
  }

  let delivered = false;
  let nudgeId = null;
  try {
    const tokens = await devicesStore.listActiveTokens();
    nudgeId = await nudgesStore.recordNudge({
      dedupKey: key, title: event.title, body: event.body, priority: nudgePriority, basis: nudgeBasis,
      status: tokens.length === 0 ? 'skipped' : 'pending',
    });
    if (tokens.length === 0) {
      // No registered device — a delivery-infrastructure gap, not an
      // interruption. Release the reservation as 'skipped' so the budget slot
      // is freed (nothing actually reached the user) and the fact stays
      // retry-eligible once a device registers.
      await attentionStore.finalizeDelivery(reservation.id, 'skipped');
      return { id: reservation.id, delivered: false, decision };
    }
    const r = await expo.sendPush(tokens, { title: event.title, body: event.body, data: { key, source: event.source } });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    if (nudgeId != null) await nudgesStore.markStatus(nudgeId, 'sent');
    await attentionStore.finalizeDelivery(reservation.id, 'delivered', { deliveredChannel: 'push' });
    delivered = true;
  } catch (err) {
    console.error('[dispatch] push failed:', err.message);
    // Retry-eligible: 'failed' leaves delivered_channel null, so it does NOT
    // start the cooldown — the next dispatch cycle re-emits and re-attempts,
    // bounded by MAX_DELIVERY_ATTEMPTS. Not a permanent suppression.
    if (nudgeId != null) await nudgesStore.markStatus(nudgeId, 'skipped');
    await attentionStore.finalizeDelivery(reservation.id, 'failed');
  }
  return { id: reservation.id, delivered, decision };
}

/** Dispatch ONE event through the full policy: build context, judge, execute.
 *  Convenience wrapper for single-event callers (watchers). Batch callers
 *  should use dispatchEvents() to avoid rebuilding context per candidate and
 *  to see budget usage accumulate correctly across the batch. */
async function dispatchEvent(event, opts = {}) {
  const context = await buildContext(opts);
  const decision = judge(event, context);
  return execute(event, decision, opts);
}

/** Dispatch a BATCH of events sharing one context build. Budget usage is
 *  tracked in-memory across the batch (each notify_now/offer_action/auto_act
 *  with a push channel increments context.budget.usedToday) so candidate #4
 *  in one run correctly sees that #1-3 already spent the budget, without a
 *  DB round-trip per candidate. */
async function dispatchEvents(events, opts = {}) {
  const context = await buildContext(opts);
  const results = [];
  for (const event of events) {
    const decision = judge(event, context);
    const result = await execute(event, decision, opts);
    results.push(result);
    if (result.delivered && decision.deliver?.consumesBudget) {
      context.budget.usedToday += 1;
    }
    if (decision.gates?.critical_reserve_consumed) {
      context.criticalBudget.usedToday += 1;
    }
    // Whatever just happened is now "recent" for the rest of THIS batch too
    // (two candidates in one run describing the same fact must not both surface).
    context.recentKeys.add(eventKey(event));
  }
  return results;
}

module.exports = { dispatchEvent, dispatchEvents, buildContext, execute, DEFAULT_DAILY_BUDGET, DEFAULT_CRITICAL_RESERVE };
