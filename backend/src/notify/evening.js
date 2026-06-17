// Evening / EOD briefing — a 6pm check-in that surfaces: today's spend, portfolio
// performance, and budget flags. Short enough to read in one glance.
// When something looks anomalous (spending spike), the notification asks about it
// rather than just reporting the number.
const devicesStore = require('../store/devices');
const metricsStore = require('../store/metrics');
const nudgesStore = require('../store/nudges');
const { sendPush } = require('./expo');
const monarchWealth = require('../services/monarch-wealth');

const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

/** Today's total spending + 30-day daily average, for anomaly detection. */
async function todaySpendWithBaseline() {
  try {
    // Spending metrics are stored at UTC midnight of the transaction date (dayTs).
    // Using setHours(0,0,0,0) would give LOCAL midnight, which on an Eastern-TZ
    // server is 4am UTC — excluding today's rows stored at 00:00Z. Instead, derive
    // the local calendar date and construct a matching UTC-midnight boundary.
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const from = new Date(`${today}T00:00:00Z`);
    const baselineFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [todayRows, baselineRows] = await Promise.all([
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: baselineFrom, to: from, agg: 'sum', excludeSource: 'seed' }),
    ]);
    const spend = todayRows.reduce((a, r) => a + Number(r.value || 0), 0);
    const baseline = baselineRows.length >= 7
      ? baselineRows.reduce((a, r) => a + Number(r.value || 0), 0) / baselineRows.length
      : null;
    return { spend, baseline };
  } catch {
    return { spend: null, baseline: null };
  }
}

/**
 * Push an end-of-day wealth snapshot.
 * Deduped per calendar day — safe to call multiple times.
 * @param {{ send?: boolean }} [opts]
 */
async function runEveningBriefing(opts = {}) {
  const send = opts.send !== false;
  const day = new Date().toISOString().slice(0, 10);
  const dedupKey = `evening_briefing:${day}`;

  // Skip if already sent today.
  const recent = await nudgesStore.recentlySentKeys(1);
  if (recent.has(dedupKey)) return { skipped: 'already_sent', sent: 0 };

  const parts = [];
  let isAnomalyQuestion = false;

  // Today's spending — detect anomaly and ask about it instead of just reporting.
  const { spend, baseline } = await todaySpendWithBaseline();
  if (spend != null && spend > 0) {
    const isSpike = baseline != null && baseline > 10 && spend > baseline * 1.8;
    if (isSpike) {
      parts.push(`You spent ${fmt(spend)} today — more than usual (avg ${fmt(baseline)}/day). Anything to explain that?`);
      isAnomalyQuestion = true;
    } else {
      parts.push(`Spent ${fmt(spend)} today.`);
    }
  }

  // Portfolio performance (7-day)
  try {
    const inv = await monarchWealth.getInvestments();
    if (inv && inv.totalValue > 0) {
      const dir = inv.periodChange >= 0 ? 'up' : 'down';
      const absPct = Math.abs(inv.periodChangePct).toFixed(1);
      parts.push(`Portfolio ${dir} ${fmt(inv.periodChange)} (${absPct}%) past 7d.`);
    }
  } catch { /* non-critical */ }

  // Budget pace — flag if any category is over budget
  try {
    const pacing = await monarchWealth.getBudgetPacing();
    if (pacing) {
      const over = pacing.lines.filter((l) => l.overBudget);
      if (over.length === 1) parts.push(`${over[0].category} is over budget.`);
      else if (over.length > 1) parts.push(`${over.length} budget categories over.`);
    }
  } catch { /* non-critical */ }

  const body = parts.length
    ? parts.join(' ')
    : "Your end-of-day snapshot — check the Wealth tab for details.";

  const n = {
    dedupKey,
    title: isAnomalyQuestion ? 'Chief of Staff 🤔' : 'EOD snapshot 📊',
    body,
    priority: 0.5,
    basis: { type: 'evening_briefing', day },
    status: 'pending',
  };
  const id = await nudgesStore.recordNudge(n);

  if (!send) return { built: true, sent: 0 };

  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { built: true, sent: 0, reason: 'no_devices' };

  try {
    const r = await sendPush(tokens, { title: n.title, body: n.body, data: { type: 'evening_briefing' } });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    await nudgesStore.markStatus(id, 'sent');
    return { built: true, sent: r.sent };
  } catch (err) {
    await nudgesStore.markStatus(id, 'failed');
    return { built: true, sent: 0, error: err.message };
  }
}

module.exports = { runEveningBriefing };
