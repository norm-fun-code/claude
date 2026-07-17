// The ONE place that decides which life-context annotations are eligible to
// explain TODAY's recovery number — shared by the full briefing build and the
// scoped chief-brief rebuild (routes/briefing.js) so neither path can drift
// from the other's definition of "a real recovery driver."
//
// Deliberately narrower than the general annotationsContext block: a
// same-day scheduling note ("big presentation today") is real context the
// brief can acknowledge, but it is NOT evidence for what moved last night's
// HRV/RHR reading. Only an annotation that is BOTH topically health-plausible
// (context-semantics.js's isPlausibleHealthCause) AND falls inside the EXACT
// overnight window that produced today's reading (analyze.js's
// resolveNightWindow — the same canonical "last night" definition
// routes/annotations.js binds a past-referring answer's effective start/end
// to) qualifies. This is what lets brain/claimValidator.js's
// checkRecoveryCause tell a genuinely grounded causal sentence from a guess.
const annotationsStore = require('../store/annotations');
const metricsStore = require('../store/metrics');
const { filterEligible } = require('./context-semantics');

/**
 * @returns {Promise<{ context: string, labels: string[], window: {start: Date, end: Date} }>}
 *   `context` — human-readable, prompt-ready summary (up to 3 drivers).
 *   `labels`  — raw annotation labels, for the claim validator to match
 *               causal sentences against (see brain/snapshot.js's
 *               canonicalFactsFrom `recoveryDrivers`).
 */
async function computeRecoveryDrivers({ tz = process.env.TZ || 'America/New_York', now = new Date() } = {}) {
  const { resolveNightWindow } = require('./analyze');
  const todayDayKey = now.toLocaleDateString('en-CA', { timeZone: tz });

  let wakeTimeSeries = [];
  try {
    const from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    wakeTimeSeries = await metricsStore.dailyAggregatePreferSource({
      domain: 'health', metric: 'wake_time', from, agg: 'avg', sources: ['eight_sleep'],
    });
  } catch { /* resolveNightWindow falls back to a default wake hour */ }

  const window = resolveNightWindow(todayDayKey, wakeTimeSeries, tz);

  let context = '';
  let labels = [];
  try {
    const candidates = await annotationsStore.overlapping(window.start, window.end);
    // 'health' purpose + a real `window` — the only combination that enforces
    // BOTH topical plausibility AND temporal alignment (isTemporallyAligned
    // otherwise skips the check entirely when window is omitted).
    const eligible = filterEligible(candidates, { purpose: 'health', window });
    if (eligible.length) {
      labels = eligible.map((a) => a.label).filter(Boolean);
      context = eligible.map((a) => `${a.label}${a.note ? ` (${a.note})` : ''}`).slice(0, 3).join('; ');
    }
  } catch (err) {
    console.error('[recovery drivers] failed:', err.message);
  }

  return { context, labels, window };
}

module.exports = { computeRecoveryDrivers };
