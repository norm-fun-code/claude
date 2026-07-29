// Canonical, versioned discretionary-spending definition — Wealth
// matched-pace audit. The ONE function that decides what counts as
// "discretionary" spend for a date range: current month, previous month,
// and every historical month in the matched-pace baseline all go through
// THIS function, so they can never disagree on what's excluded.
//
// Root cause this replaces: wealth-pace.js used to sum the
// `wealth:spending_discretionary` metrics-table row for each historical
// month. Those rows are written by whichever version of the exclusion
// rules (connectors/monarch.js's isFixedCategory/isInternalTransfer) was
// live on the day they were computed, with no marker distinguishing an
// older-definition row from a current one — a month computed before a
// category was added to the fixed/transfer lists (or before a dedup fix)
// could sit in the trailing-month median pool indefinitely, silently
// skewing the "typical" baseline. Computing every month LIVE from the
// canonical `documents` transaction corpus, through this one function,
// against the CURRENT exclusion rules, eliminates that class of bug by
// construction: there is no stored per-month total to go stale.
'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const documentsStore = require('../store/documents');
const { isInternalTransfer, isFixedCategory, fixedCategories, transferCategories } = require('../connectors/monarch');

// Wealth matched-pace hardening pass: the definition version represents the
// EFFECTIVE exclusion rules in force right now (fixedCategories()/
// transferCategories(), which can be overridden per-deployment via
// MONARCH_FIXED_CATEGORIES/MONARCH_TRANSFER_CATEGORIES), not a hand-bumped
// constant a developer can forget to change — a config override changes the
// version automatically, so two environments running different exclusion
// rules can never be mistaken for comparable data by a diagnostic report.
// Deliberately excludes the algorithm version below (kept separate) so a
// pure classification-logic change is still visible without conflating it
// with a config change.
const DISCRETIONARY_ALGORITHM_VERSION = 2; // bump on classify()/query-shape changes (e.g. refund-netting fix)
function definitionVersion() {
  const config = { algorithm: DISCRETIONARY_ALGORITHM_VERSION, fixed: fixedCategories(), transfers: transferCategories() };
  const hash = crypto.createHash('sha1').update(JSON.stringify(config)).digest('hex').slice(0, 12);
  return `v${DISCRETIONARY_ALGORITHM_VERSION}-${hash}`;
}
// Legacy numeric constant, kept only so any still-persisted old value
// (e.g. an old metrics-table row's definitionVersion field) is recognizably
// stale rather than a parse error. No code path writes this anymore.
const DISCRETIONARY_DEFINITION_VERSION = 1;

/** Pure: split documents.categorySpendInRange's per-category rows into
 *  discretionary vs. excluded (internal transfers, fixed housing) — the
 *  ONE predicate every caller here shares. Order matters only for rows
 *  that could plausibly match both lists; in practice the two lists are
 *  disjoint (transfers vs. housing), so this is a straightforward filter. */
function classify(rows) {
  const discretionary = [];
  const fixed = [];
  const transfers = [];
  for (const r of rows) {
    if (isInternalTransfer(r.category)) transfers.push(r);
    else if (isFixedCategory(r.category)) fixed.push(r);
    else discretionary.push(r);
  }
  const sum = (list) => list.reduce((a, r) => a + r.spend, 0);
  return {
    discretionary, fixed, transfers,
    discretionaryTotal: sum(discretionary),
    fixedTotal: sum(fixed),
    transfersTotal: sum(transfers),
  };
}

/** Pure: classify+aggregate a set of already-fetched raw (day, category,
 *  amount) rows into the canonical breakdown shape, scoped to a [fromYmd,
 *  toYmd] window. Refund-netting semantics: sum per category, a positive
 *  refund/credit row nets its category's total down, keep only categories
 *  with positive net spend. Also tracks, for the categories that end up
 *  counted as discretionary, the gross purchase total and the refund
 *  amount netted OUT of it — the production reconciliation report's
 *  "refunds/credits netted" line (routes/diagnostics.js's
 *  /api/diag/wealth-pace), so `discretionaryTotal` is always exactly
 *  `discretionaryGrossPurchases - discretionaryRefundsNetted` and never an
 *  opaque final number. */
function breakdownFromRows(rows, fromYmd, toYmd) {
  const byCategory = new Map(); // category -> { net, gross, refunds }
  for (const r of rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, { net: 0, gross: 0, refunds: 0 });
    const c = byCategory.get(r.category);
    c.net -= r.amount;
    if (r.amount < 0) c.gross += -r.amount; else c.refunds += r.amount;
  }
  const categoryRows = [...byCategory.entries()]
    .map(([category, v]) => ({ category, spend: v.net, gross: v.gross, refunds: v.refunds }))
    .filter((r) => r.spend > 0);
  const { discretionary, fixed, transfers, discretionaryTotal, fixedTotal, transfersTotal } = classify(categoryRows);
  const discretionaryGrossPurchases = Math.round(discretionary.reduce((a, r) => a + r.gross, 0));
  const discretionaryRefundsNetted = Math.round(discretionary.reduce((a, r) => a + r.refunds, 0));
  return {
    fromYmd, toYmd,
    totalEconomicSpend: Math.round(discretionaryTotal + fixedTotal),
    discretionaryTotal: Math.round(discretionaryTotal),
    discretionaryGrossPurchases,
    discretionaryRefundsNetted,
    fixedExcluded: {
      total: Math.round(fixedTotal),
      categories: fixed.map((r) => ({ category: r.category, amount: Math.round(r.spend) })),
    },
    transfersExcluded: {
      total: Math.round(transfersTotal),
      categories: transfers.map((r) => ({ category: r.category, amount: Math.round(r.spend) })),
    },
    discretionaryByCategory: discretionary.map((r) => ({ category: r.category, amount: Math.round(r.spend) })),
    source: 'monarch',
    definitionVersion: definitionVersion(),
  };
}

/**
 * The canonical, auditable breakdown for an arbitrary [fromYmd, toYmd]
 * local-date range (both inclusive) — total economic spend (discretionary
 * + fixed; transfers are never economic spend at all), the fixed-housing
 * exclusion (with categories/amounts), the internal-transfer exclusion,
 * the refund/credit amount netted out, and the resulting discretionary
 * total. Every caller comparing "this month" against "typical" MUST go
 * through this one function for BOTH sides — never compare a total-spend
 * figure against a discretionary one. Shares breakdownFromRows with
 * batchDiscretionaryBreakdown so a single-window call and a batched call
 * for the same window can never disagree.
 */
async function discretionaryBreakdown({ fromYmd, toYmd }) {
  const rows = await documentsStore.rawSpendRowsInRange({ fromYmd, toYmd });
  return breakdownFromRows(rows, fromYmd, toYmd);
}

/**
 * Resolve MANY [fromYmd, toYmd] windows (wealth-pace.js's current month +
 * up to 13 trailing historical months) in ONE database round trip instead
 * of one query per window. Wealth matched-pace hardening pass, efficiency
 * requirement: fetches every document across the UNION of all requested
 * windows with a single bounded query, then classifies/aggregates each
 * window from the in-memory result set — the SAME classify() predicate
 * discretionaryBreakdown uses, so the batched and single-window paths can
 * never disagree.
 *
 * @param {Array<{key: string, fromYmd: string, toYmd: string}>} windows
 * @returns {Promise<Record<string, ReturnType<typeof breakdownFromRows>>>} keyed by window.key
 */
async function batchDiscretionaryBreakdown(windows) {
  if (!windows.length) return {};
  let overallFrom = windows[0].fromYmd;
  let overallTo = windows[0].toYmd;
  for (const w of windows) {
    if (w.fromYmd < overallFrom) overallFrom = w.fromYmd;
    if (w.toYmd > overallTo) overallTo = w.toYmd;
  }
  const rows = await documentsStore.rawSpendRowsInRange({ fromYmd: overallFrom, toYmd: overallTo });
  const result = {};
  for (const w of windows) {
    const windowRows = rows.filter((r) => r.day >= w.fromYmd && r.day <= w.toYmd);
    result[w.key] = breakdownFromRows(windowRows, w.fromYmd, w.toYmd);
  }
  return result;
}

/** The earliest local date this account has ANY Monarch transaction
 *  document for — the coverage floor for historical-month eligibility. A
 *  historical month's matched window is only genuinely complete if the
 *  account had data flowing before that window even started; a missing
 *  document for a day can't be told apart from "genuinely no spending
 *  that day" any other way, so eligibility is gated on window-start vs.
 *  this floor instead of a per-day row-presence heuristic. Returns null
 *  if there are no Monarch documents at all yet.
 *
 *  Wealth matched-pace hardening pass: this is now a FALLBACK only, used
 *  when no source has recorded a coverage interval yet (e.g. before this
 *  change's coverage-interval tracking has run at least once) — the
 *  primary eligibility check is services/coverageIntervals.js's
 *  isFullyCovered against the source's proven sync coverage, since
 *  "earliest document <= window start" does NOT prove the ENTIRE window
 *  was synced (a partial/failed backfill can leave a real gap inside an
 *  otherwise-old account). */
async function earliestMonarchDocumentDate() {
  const { rows } = await query(`SELECT MIN(occurred_at)::date AS d FROM documents WHERE source = 'monarch'`);
  const d = rows[0]?.d;
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

module.exports = {
  DISCRETIONARY_DEFINITION_VERSION,
  definitionVersion,
  discretionaryBreakdown,
  batchDiscretionaryBreakdown,
  earliestMonarchDocumentDate,
  classify,
};
