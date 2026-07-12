// Wealth-specific proactive nudges: over-budget categories, new recurring charges,
// and spending anomalies. Runs after the morning Monarch sync, feeds the nudge
// pipeline with deduped, once-per-period alerts — now routed through the
// Attention Policy (notify/dispatch.js) instead of deciding delivery itself.
const monarchWealth = require('../services/monarch-wealth');
const { fromWealthCandidate } = require('./events');

const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

/**
 * Generate and push wealth nudges. Deduped per billing period so each alert
 * fires at most once until the underlying condition changes.
 * @param {{ send?: boolean }} [opts]
 */
async function runWealthNudges(opts = {}) {
  if (!monarchWealth.isConfigured()) return { skipped: 'monarch_not_configured', sent: 0 };
  const send = opts.send !== false;

  const [pacing, recurring] = await Promise.allSettled([
    monarchWealth.getBudgetPacing(),
    monarchWealth.getRecurring(),
  ]);

  const nudges = [];
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM

  // 1) Over-budget categories — dedupe by category+month so it fires once
  //    mid-month when first crossed, not every morning after.
  const pacingData = pacing.status === 'fulfilled' ? pacing.value : null;
  if (pacingData) {
    for (const l of (pacingData.lines || []).filter((l) => l.overBudget)) {
      nudges.push({
        dedupKey: `over_budget:${l.category}:${month}`,
        title: `Over budget: ${l.category}`,
        body: `${l.category}: ${fmt(l.actual)} spent against a ${fmt(l.budget)} budget — ${fmt(Math.abs(l.remaining))} over (day ${pacingData.dayOfMonth}/${pacingData.daysInMonth}).`,
        priority: 0.7,
        basis: { type: 'over_budget', category: l.category, actual: l.actual, budget: l.budget, month },
      });
    }

    // Pacing alert (on pace to overspend but not yet over) — daily dedup.
    const day = new Date().toISOString().slice(0, 10);
    for (const l of (pacingData.lines || []).filter((l) => !l.overBudget && l.pace >= 1.5)) {
      nudges.push({
        dedupKey: `budget_pace:${l.category}:${day}`,
        title: `${l.category} spending fast`,
        body: `On pace to overspend ${l.category} this month — already ${Math.round((l.pace - 1) * 100)}% ahead of schedule.`,
        priority: 0.5,
        basis: { type: 'budget_pace', category: l.category, pace: l.pace, month },
      });
    }
  }

  // 2) New recurring charges. The old code carried its OWN 60-day dedup here
  //    (recentlySentKeys against a 'new_recurring:<id>' key) plus a break after
  //    the first, to surface one genuinely-new charge per run. Both are gone:
  //    the attention policy now owns dedup via the month-bucketed event_key
  //    'wealth:new_recurring:<name>:<YYYY-MM>' (a 60-day cooldown, so each
  //    distinct charge alerts at most once), and its per-type urgency keeps
  //    new_recurring at add_to_brief (never a push) so building one candidate
  //    per qualifying charge can't flood — it just seeds the brief once, then
  //    the cooldown suppresses repeats. Keeping the old stale-format pre-filter
  //    would silently break: it checks a key the ledger no longer writes, so
  //    the break would fix on the first charge every run and a genuinely-new
  //    SECOND charge would never be considered.
  const recurringData = recurring.status === 'fulfilled' ? recurring.value : null;
  if (recurringData) {
    for (const s of recurringData.expenses.slice(0, 20)) {
      if (s.annual >= 50) {
        nudges.push({
          dedupKey: `new_recurring:${s.id || s.name}`,
          title: `New recurring: ${s.name}`,
          body: `Monarch detected "${s.name}" as a recurring ${s.frequency} charge — ${fmt(s.monthly)}/mo (${fmt(s.annual)}/yr).`,
          priority: 0.6,
          basis: { type: 'new_recurring', name: s.name, monthly: s.monthly, annual: s.annual },
        });
      }
    }
  }

  if (nudges.length === 0) return { generated: 0, sent: 0 };

  // The old per-run recentlySentKeys(2) pre-filter is gone — the attention
  // policy's own cooldown (attention_log, keyed by the normalized event's
  // event_key: domain:type:subject:bucket) is now the authoritative gate,
  // and it fires on any judged user-facing disposition, not just a delivered
  // push, so it catches more than the old delivered-only pre-filter did.
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const events = nudges.map((n) => fromWealthCandidate(n, { asOf }));
  const { dispatchEvents } = require('../notify/dispatch');
  const results = await dispatchEvents(events, { asOf, send, force: opts.force });

  let sentCount = 0;
  const out = nudges.map((n, i) => {
    const r = results[i];
    if (r.delivered) sentCount += 1;
    return { ...n, disposition: r.decision.disposition, reason: r.decision.reason };
  });

  return { generated: nudges.length, sent: sentCount, nudges: out };
}

module.exports = { runWealthNudges };
