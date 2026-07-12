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
const { sendPush } = require('./expo');
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
  const wantsPush = decision.deliver?.channel === 'push';
  let delivered = false;
  let deliveredChannel = decision.deliver?.channel ?? null;
  const key = eventKey(event);

  if (wantsPush) {
    try {
      // Mirrors the pre-policy watchers exactly: tokens are only fetched
      // (and a real push only attempted) when `send` is true; a dry-run
      // caller (send:false — tests, --dry-run CLI flags) still records the
      // `nudges` row as 'pending', matching old watch.js/runNudges behavior,
      // so callers inspecting that table after a dry run see what WOULD have
      // gone out.
      const tokens = send ? await devicesStore.listActiveTokens() : [];
      const nudgeStatus = send && tokens.length === 0 ? 'skipped' : 'pending';
      const nudgeId = await nudgesStore.recordNudge({
        dedupKey: key, title: event.title, body: event.body,
        priority: decision.scores?.value ?? 0.5,
        basis: { type: event.type, source: event.source, domain: event.domain, subject: event.subject },
        status: nudgeStatus,
      });
      if (send && tokens.length > 0) {
        const r = await sendPush(tokens, { title: event.title, body: event.body, data: { key, source: event.source } });
        for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
        if (nudgeId != null) await nudgesStore.markStatus(nudgeId, 'sent');
        delivered = true;
      } else {
        // Either a dry run, or no device registered (a delivery-
        // infrastructure gap, not a policy decision) — nothing was actually
        // sent, so this event's ledger slot is an audit fact, not a real
        // interruption.
        deliveredChannel = null;
      }
    } catch (err) {
      console.error('[dispatch] push failed:', err.message);
      deliveredChannel = null; // delivery failure -> not counted as delivered
    }
  }

  const id = await attentionStore.record({ event, decision, delivered, deliveredChannel: delivered ? deliveredChannel : null });
  return { id, delivered, decision };
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
