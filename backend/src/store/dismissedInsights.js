// Card-level dismissal for "What The Data Shows" insights. Some flagged insights
// are nothing the user is concerned about (e.g. a recurring car payment shown as
// "review this subscription"). They can dismiss it and it stays gone.
//
// The key is a STABLE signature — type + the title with numbers/currency stripped
// — so a recurring insight whose amount drifts month to month stays dismissed.
const { query } = require('../db');

/** Stable dismissal key for an insight: `type|title-without-numbers`. Pure, so
 *  the server computes the same key when filtering as when the client dismisses. */
function dismissKey(insight) {
  const type = String(insight?.type || 'insight');
  const title = String(insight?.title || '')
    .toLowerCase()
    .replace(/[$£€]/g, ' ')
    .replace(/[0-9]+([.,][0-9]+)*%?/g, ' ') // strip dollar amounts, counts, percentages
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${type}|${title}`;
}

async function dismiss(key, title = null) {
  if (!key) return;
  await query(
    `INSERT INTO dismissed_insights (dismiss_key, title) VALUES ($1, $2)
       ON CONFLICT (dismiss_key) DO NOTHING`,
    [key, title]
  );
}

async function undismiss(key) {
  if (!key) return;
  await query(`DELETE FROM dismissed_insights WHERE dismiss_key = $1`, [key]);
}

/** All dismissed keys as a Set, for filtering. Fail-safe: empty set on error. */
async function dismissedKeys() {
  try {
    const { rows } = await query(`SELECT dismiss_key FROM dismissed_insights`);
    return new Set(rows.map((r) => r.dismiss_key));
  } catch {
    return new Set();
  }
}

async function listDismissed() {
  const { rows } = await query(
    `SELECT dismiss_key, title, dismissed_at FROM dismissed_insights ORDER BY dismissed_at DESC`
  );
  return rows;
}

/** Annotate each insight with its stable dismissKey and drop any that are
 *  dismissed. `dismissed` is the Set from dismissedKeys(). */
function applyDismissals(insights, dismissed) {
  if (!Array.isArray(insights)) return insights;
  return insights
    .map((i) => ({ ...i, dismissKey: dismissKey(i) }))
    .filter((i) => !dismissed.has(i.dismissKey));
}

module.exports = { dismissKey, dismiss, undismiss, dismissedKeys, listDismissed, applyDismissals };
