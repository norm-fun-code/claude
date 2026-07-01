// Forward-looking cashflow check — flags upcoming recurring bills (from
// Monarch's recurring-transaction forecast) that would land before the current
// cash buffer can comfortably absorb them. The point is to warn BEFORE a bill
// hits, not report on it after the balance already dropped — most finance
// surfaces (including this app's own spending-anomaly check) are rearview by
// nature; this is the one deliberately forward-looking money signal.
const { classifyAccount } = require('./allocation');

const DAY = 24 * 60 * 60 * 1000;

/**
 * Pure. streams: normalized recurring streams (expenses, optionally credit
 * cards) from monarch-wealth.getRecurring(), each with {name, amount, nextDate}.
 * accounts: normalized accounts from monarch-wealth.getAccounts().
 * Returns { upcoming, totalUpcoming, cashBuffer, thin, detail }. `detail` is a
 * ready-to-use one-line string when the buffer looks genuinely tight against
 * what's coming, else null — this is a "worth a heads-up" bar, not a warning on
 * every routine bill (rent hits every month; that alone isn't news).
 */
function computeCashflowLookahead({
  streams = [], accounts = [], days = 4, thinRatio = 0.35, thinFloor = 500, asOf = new Date(),
} = {}) {
  const nowMs = asOf.getTime();
  const horizonMs = nowMs + days * DAY;
  const upcoming = streams
    .filter((s) => s.nextDate && s.amount > 0)
    .map((s) => {
      const dueMs = new Date(s.nextDate).getTime();
      return { name: s.name, amount: s.amount, dueMs, daysAway: Math.ceil((dueMs - nowMs) / DAY) };
    })
    .filter((s) => Number.isFinite(s.dueMs) && s.dueMs >= nowMs && s.dueMs <= horizonMs)
    .sort((a, b) => a.dueMs - b.dueMs);

  if (!upcoming.length) return { upcoming: [], totalUpcoming: 0, cashBuffer: null, thin: false, detail: null };

  const totalUpcoming = upcoming.reduce((s, u) => s + u.amount, 0);
  const cashBuffer = accounts.length
    ? accounts.filter((a) => a.isAsset && classifyAccount(a) === 'cash').reduce((s, a) => s + a.balance, 0)
    : null;

  const thin = cashBuffer != null && cashBuffer > 0 &&
    (totalUpcoming / cashBuffer >= thinRatio || cashBuffer - totalUpcoming < thinFloor);

  let detail = null;
  if (thin) {
    const names = upcoming
      .slice(0, 3)
      .map((u) => `${u.name} ($${Math.round(u.amount)}, ${u.daysAway <= 0 ? 'today' : u.daysAway === 1 ? 'tomorrow' : `in ${u.daysAway}d`})`);
    detail = `$${Math.round(totalUpcoming)} in recurring bills due in the next ${days} days (${names.join(', ')}) against a $${Math.round(cashBuffer)} cash buffer — worth checking before it hits, not after.`;
  }
  return { upcoming, totalUpcoming, cashBuffer, thin, detail };
}

module.exports = { computeCashflowLookahead };
