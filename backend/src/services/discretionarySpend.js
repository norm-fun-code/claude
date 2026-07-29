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

const { query } = require('../db');
const documentsStore = require('../store/documents');
const { isInternalTransfer, isFixedCategory } = require('../connectors/monarch');

// Bump whenever the exclusion predicate changes (a new fixed/transfer
// category, a new dedup rule, a new source). Surfaced in the diagnostic
// report so a future incident can tell at a glance which rules produced a
// given number — see routes/diagnostics.js's /api/diag/wealth-pace.
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

/**
 * The canonical, auditable breakdown for an arbitrary [fromYmd, toYmd]
 * local-date range (both inclusive) — total economic spend (discretionary
 * + fixed; transfers are never economic spend at all), the fixed-housing
 * exclusion (with categories/amounts), the internal-transfer exclusion,
 * and the resulting discretionary total. Every caller comparing "this
 * month" against "typical" MUST go through this one function for BOTH
 * sides — never compare a total-spend figure against a discretionary one.
 */
async function discretionaryBreakdown({ fromYmd, toYmd }) {
  const rows = await documentsStore.categorySpendInRange({ fromYmd, toYmd });
  const { discretionary, fixed, transfers, discretionaryTotal, fixedTotal, transfersTotal } = classify(rows);
  return {
    fromYmd, toYmd,
    totalEconomicSpend: Math.round(discretionaryTotal + fixedTotal),
    discretionaryTotal: Math.round(discretionaryTotal),
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
    definitionVersion: DISCRETIONARY_DEFINITION_VERSION,
  };
}

/** The earliest local date this account has ANY Monarch transaction
 *  document for — the coverage floor for historical-month eligibility. A
 *  historical month's matched window is only genuinely complete if the
 *  account had data flowing before that window even started; a missing
 *  document for a day can't be told apart from "genuinely no spending
 *  that day" any other way, so eligibility is gated on window-start vs.
 *  this floor instead of a per-day row-presence heuristic. Returns null
 *  if there are no Monarch documents at all yet. */
async function earliestMonarchDocumentDate() {
  const { rows } = await query(`SELECT MIN(occurred_at)::date AS d FROM documents WHERE source = 'monarch'`);
  const d = rows[0]?.d;
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

module.exports = {
  DISCRETIONARY_DEFINITION_VERSION,
  discretionaryBreakdown,
  earliestMonarchDocumentDate,
  classify,
};
