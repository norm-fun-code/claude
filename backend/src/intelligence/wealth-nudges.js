// Wealth-specific proactive nudges: over-budget categories, new recurring charges,
// and spending anomalies. Runs after the morning Monarch sync, feeds the nudge
// pipeline with deduped, once-per-period alerts.
const nudgesStore = require('../store/nudges');
const devicesStore = require('../store/devices');
const { sendPush } = require('../notify/expo');
const monarchWealth = require('../services/monarch-wealth');

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

  // 2) New recurring charge — compare today's Monarch list against stored dedup keys.
  //    A "new" expense is one whose dedup key hasn't been seen in the last 60 days.
  const recurringData = recurring.status === 'fulfilled' ? recurring.value : null;
  if (recurringData) {
    const recentKeys = await nudgesStore.recentlySentKeys(60);
    for (const s of recurringData.expenses.slice(0, 20)) {
      const key = `new_recurring:${s.id || s.name}`;
      if (!recentKeys.has(key) && s.annual >= 50) {
        nudges.push({
          dedupKey: key,
          title: `New recurring: ${s.name}`,
          body: `Monarch detected "${s.name}" as a recurring ${s.frequency} charge — ${fmt(s.monthly)}/mo (${fmt(s.annual)}/yr).`,
          priority: 0.6,
          basis: { type: 'new_recurring', name: s.name, monthly: s.monthly, annual: s.annual },
        });
        break; // one new-charge alert per run to avoid flooding
      }
    }
  }

  if (nudges.length === 0) return { generated: 0, sent: 0 };

  const recentKeys = await nudgesStore.recentlySentKeys(2);
  const toSend = nudges.filter((n) => !recentKeys.has(n.dedupKey));
  if (toSend.length === 0) return { generated: nudges.length, deduped: nudges.length, sent: 0 };

  const tokens = send ? await devicesStore.listActiveTokens() : [];
  let sentCount = 0;

  for (const n of toSend) {
    const status = send && tokens.length === 0 ? 'skipped' : 'pending';
    const id = await nudgesStore.recordNudge({ ...n, status });
    // null means another concurrent caller already claimed this exact nudge
    // (recordNudge's atomic dedup guard) — don't push a second time.
    if (id == null) continue;
    if (send && tokens.length > 0) {
      try {
        const r = await sendPush(tokens, { title: n.title, body: n.body, data: { key: n.dedupKey } });
        for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
        await nudgesStore.markStatus(id, 'sent');
        sentCount += 1;
      } catch (err) {
        await nudgesStore.markStatus(id, 'failed');
        console.error('[wealth-nudges] push failed:', err.message);
      }
    }
  }

  return { generated: nudges.length, sent: sentCount, devices: tokens.length };
}

module.exports = { runWealthNudges };
