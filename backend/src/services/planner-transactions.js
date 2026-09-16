'use strict';
// Read-only transactions for the family planner.
//
// NormOS already pulls transactions for its own spending analysis, but that query selects only
// what a briefing needs: a name, a date, an amount. The planner's sync is incremental and
// idempotent, which needs more — a STABLE id to upsert against, `updatedAt` so a
// recategorisation weeks later is re-read, `pending` so a hold reconciles into the charge that
// replaces it, and category and account IDs rather than display names, because a renamed
// category must not look like a different one.
//
// So this is its own query and its own shape. The planner never speaks to Monarch; it receives
// exactly the fields its own store is keyed on, and nothing else.

const TRANSACTIONS_QUERY = `query NormOS_PlannerTransactions($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
  allTransactions(filters: $filters) {
    totalCount
    results(offset: $offset, limit: $limit, orderBy: $orderBy) {
      id amount pending date hideFromReports plaidName notes
      isRecurring isSplitTransaction createdAt updatedAt
      category { id name }
      merchant { id name }
      account { id displayName }
      tags { id name }
    }
  }
}`;

const CATEGORIES_QUERY = `query NormOS_PlannerCategories {
  categories { id order name systemCategory isSystemCategory isDisabled updatedAt group { id name type } }
}`;

const PAGE_SIZE = 100;
const MAX_PAGE = 500;

const numOr0 = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') { const n = parseFloat(v.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; }
  return 0;
};

// The flat row the planner's store is keyed on. Ids are stringified because Monarch returns
// them as numbers or strings depending on the field, and a mixed-type primary key breaks the
// idempotent upsert this whole feed exists to support.
function shapeTransaction(t) {
  const id = t && t.id != null ? String(t.id) : null;
  if (!id) return null;
  return {
    id,
    date: String(t.date || '').slice(0, 10),
    amount: numOr0(t.amount),
    merchant: (t.merchant && t.merchant.name) || '',
    plaidName: t.plaidName || '',
    notes: t.notes || '',
    categoryId: t.category && t.category.id != null ? String(t.category.id) : null,
    categoryName: (t.category && t.category.name) || '',
    accountId: t.account && t.account.id != null ? String(t.account.id) : null,
    accountName: (t.account && t.account.displayName) || '',
    pending: !!t.pending,
    hideFromReports: !!t.hideFromReports,
    isRecurring: !!t.isRecurring,
    isSplitTransaction: !!t.isSplitTransaction,
    tags: (t.tags || []).map(x => (x && x.name) || '').filter(Boolean),
    updatedAt: t.updatedAt || null,
    createdAt: t.createdAt || null,
  };
}

// A window the planner asked for, validated here rather than trusted. An unbounded or
// inverted range is a bug on the caller's side, and answering it would hand back the whole
// history under a credential scoped to one endpoint.
function transactionWindow({ start, end, offset, limit }) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(start || '')) || !iso.test(String(end || ''))) throw new Error('Give start and end as YYYY-MM-DD.');
  if (start > end) throw new Error('The window ends before it starts.');
  // `??`, not `||`: an explicit 0 is a caller bug worth rejecting, and `||` silently turned
  // it into a full page of 100 — the same class of mistake as reading a deliberate zero
  // balance as "absent".
  const off = Number(offset ?? 0), lim = Number(limit ?? PAGE_SIZE);
  if (!Number.isInteger(off) || off < 0) throw new Error('Offset must be a whole number, zero or more.');
  if (!Number.isInteger(lim) || lim < 1 || lim > MAX_PAGE) throw new Error(`Limit must be between 1 and ${MAX_PAGE}.`);
  return { startDate: start, endDate: end, offset: off, limit: lim };
}

async function fetchTransactionPage(gql, token, window) {
  const d = await gql(token, TRANSACTIONS_QUERY, {
    offset: window.offset, limit: window.limit,
    filters: { startDate: window.startDate, endDate: window.endDate },
    orderBy: 'date',
  });
  const all = d.allTransactions || {};
  return {
    totalCount: Number(all.totalCount) || 0,
    // A row without an id cannot be upserted, so it is dropped rather than passed on to fail
    // deeper in. Nothing else is filtered — the planner decides what it cares about.
    results: (all.results || []).map(shapeTransaction).filter(Boolean),
  };
}

async function fetchCategories(gql, token) {
  const d = await gql(token, CATEGORIES_QUERY, {});
  const rows = d.categories || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error('Monarch returned no categories.');
  return rows;
}

module.exports = { TRANSACTIONS_QUERY, CATEGORIES_QUERY, PAGE_SIZE, MAX_PAGE,
  shapeTransaction, transactionWindow, fetchTransactionPage, fetchCategories };
