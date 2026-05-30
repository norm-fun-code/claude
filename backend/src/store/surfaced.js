// Ledger of already-shown knowledge highlights / insight cards, so the daily
// briefing doesn't repeat the same one within a rolling window (default 30 days).
const { query } = require('../db');

/** Refs of a kind surfaced within the last `days` — the "don't repeat" set. */
async function recentRefs(kind, days = 30) {
  const { rows } = await query(
    `SELECT DISTINCT ref FROM surfaced
      WHERE kind = $1 AND surfaced_at >= now() - ($2 || ' days')::interval`,
    [kind, String(days)]
  );
  return new Set(rows.map((r) => r.ref));
}

/** Record that one or more refs were surfaced today. */
async function record(kind, refs) {
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean).map(String);
  if (list.length === 0) return 0;
  const values = [];
  const tuples = list.map((ref, i) => {
    values.push(kind, ref);
    return `($${i * 2 + 1}, $${i * 2 + 2})`;
  });
  await query(`INSERT INTO surfaced (kind, ref) VALUES ${tuples.join(', ')}`, values);
  return list.length;
}

/**
 * Pure helper: from `candidates`, return up to `max` whose id (via keyFn) wasn't
 * surfaced recently. Falls back to the original order if everything's been seen,
 * so we never show nothing.
 */
function pickFresh(candidates, recent, { max = 1, keyFn = (x) => x } = {}) {
  const fresh = candidates.filter((c) => !recent.has(String(keyFn(c))));
  const chosen = fresh.slice(0, max);
  if (chosen.length < max) {
    // top up with already-seen items (least-bad fallback) to honor `max`
    for (const c of candidates) {
      if (chosen.length >= max) break;
      if (!chosen.includes(c)) chosen.push(c);
    }
  }
  return chosen;
}

module.exports = { recentRefs, record, pickFresh };
