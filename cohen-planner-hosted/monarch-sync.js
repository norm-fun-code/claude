'use strict';
// ═══ TRANSACTION SYNC ═══
// Persistence and reconciliation for the Monarch transaction ledger. The transport lives in
// monarch-live.js; this module owns "what is true locally after a sync".
//
// Four properties it has to hold, because getting any of them wrong corrupts every number
// downstream and the corruption is silent:
//
//   idempotent   — re-running a sync over the same window changes nothing. Rows are keyed on
//                  Monarch's own transaction id, so a re-read updates in place.
//   reconciling  — a pending charge that posts arrives with the SAME id and a settled amount
//                  and date; it must update, not insert a second row.
//   deleting     — a transaction removed or merged upstream simply stops appearing. Absence
//                  is only meaningful over a window we actually re-read in full, so
//                  deletions are detected per-window and recorded as soft deletes.
//   preserving   — a user's own categorisation is theirs. Sync never overwrites it.
//
// Failures retain last-good data: a partial or failed sync must never leave the ledger worse
// than before it started, so nothing is deleted on a window that errored.

const SYNC_KEY = 'monarch_tx_sync';

function createMonarchSync({ db, live, now = Date.now }) {

  // ── Schema ───────────────────────────────────────────────────────────────
  async function initSchema() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS monarch_transactions (
        id            TEXT PRIMARY KEY,
        date          DATE NOT NULL,
        amount        NUMERIC NOT NULL,
        merchant      TEXT,
        plaid_name    TEXT,
        notes         TEXT,
        category_id   TEXT,
        category_name TEXT,
        account_id    TEXT,
        account_name  TEXT,
        pending       BOOLEAN DEFAULT FALSE,
        hide_from_reports BOOLEAN DEFAULT FALSE,
        is_recurring  BOOLEAN DEFAULT FALSE,
        is_split      BOOLEAN DEFAULT FALSE,
        tags          JSONB DEFAULT '[]'::jsonb,
        provider_updated_at TIMESTAMPTZ,
        synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at    TIMESTAMPTZ,
        -- Local overrides. Sync writes every other column; it never writes these.
        user_kind        TEXT,
        user_category_id TEXT,
        user_note        TEXT
      );
      CREATE INDEX IF NOT EXISTS monarch_tx_date ON monarch_transactions (date);
      CREATE INDEX IF NOT EXISTS monarch_tx_live ON monarch_transactions (date) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS monarch_categories (
        id TEXT PRIMARY KEY, name TEXT, group_id TEXT, group_name TEXT, group_type TEXT,
        system_category TEXT, is_disabled BOOLEAN DEFAULT FALSE, synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS monarch_budgets (
        month TEXT NOT NULL, category_id TEXT NOT NULL,
        planned NUMERIC, actual NUMERIC, remaining NUMERIC,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (month, category_id)
      );
    `);
  }

  async function state() {
    const { rows } = await db.query('SELECT data FROM oauth_tokens WHERE key = $1', [SYNC_KEY]);
    return rows[0]?.data || { windows: {}, lastSyncAt: null, firstDate: null, lastError: null };
  }
  async function saveState(patch) {
    const next = { ...(await state()), ...patch };
    await db.query(
      `INSERT INTO oauth_tokens (key, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`, [SYNC_KEY, JSON.stringify(next)]);
    return next;
  }

  // ── Upsert ───────────────────────────────────────────────────────────────
  // Idempotent on Monarch's id. Note what is NOT in the UPDATE list: user_kind,
  // user_category_id and user_note. A re-sync must not undo the user's own work, and the
  // only way to guarantee that is to never write those columns here.
  //
  // deleted_at is cleared on write: a row reappearing upstream is a resurrection, not a
  // second transaction, and leaving it soft-deleted would hide real spending.
  async function upsert(rows) {
    let written = 0;
    for (const t of rows) {
      if (!t || !t.id) continue;
      await db.query(
        `INSERT INTO monarch_transactions
           (id,date,amount,merchant,plaid_name,notes,category_id,category_name,account_id,
            account_name,pending,hide_from_reports,is_recurring,is_split,tags,
            provider_updated_at,synced_at,deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,NOW(),NULL)
         ON CONFLICT (id) DO UPDATE SET
           date=EXCLUDED.date, amount=EXCLUDED.amount, merchant=EXCLUDED.merchant,
           plaid_name=EXCLUDED.plaid_name, notes=EXCLUDED.notes,
           category_id=EXCLUDED.category_id, category_name=EXCLUDED.category_name,
           account_id=EXCLUDED.account_id, account_name=EXCLUDED.account_name,
           pending=EXCLUDED.pending, hide_from_reports=EXCLUDED.hide_from_reports,
           is_recurring=EXCLUDED.is_recurring, is_split=EXCLUDED.is_split,
           tags=EXCLUDED.tags, provider_updated_at=EXCLUDED.provider_updated_at,
           synced_at=NOW(), deleted_at=NULL`,
        [t.id, t.date, t.amount, t.merchant, t.plaidName, t.notes, t.categoryId, t.categoryName,
         t.accountId, t.accountName, t.pending, t.hideFromReports, t.isRecurring,
         t.isSplitTransaction, JSON.stringify(t.tags || []), t.updatedAt]);
      written++;
    }
    return written;
  }

  // Soft-delete rows inside a window we just re-read in FULL that Monarch no longer returns.
  // Scoped to the window on purpose: absence outside it means nothing, and deleting on that
  // basis would erase history the sync simply did not ask for.
  async function reconcileDeletions(startDate, endDate, seenIds) {
    const ids = [...seenIds];
    const { rows } = await db.query(
      `UPDATE monarch_transactions SET deleted_at = NOW()
        WHERE date >= $1 AND date <= $2 AND deleted_at IS NULL
          AND NOT (id = ANY($3::text[]))
        RETURNING id`, [startDate, endDate, ids]);
    return rows.length;
  }

  // ── Windowed pull ────────────────────────────────────────────────────────
  // Pages until the reported total is covered. The page cap is a guard against a totalCount
  // that never converges — an infinite loop against a paid API is worse than a short read.
  async function pullWindow(startDate, endDate, { maxPages = 200 } = {}) {
    const seen = new Set();
    let offset = 0, total = null, pages = 0, written = 0;
    while (pages < maxPages) {
      const page = await live.transactionsPage({ startDate, endDate, offset });
      if (total === null) total = page.totalCount;
      const rows = (page.results || []).filter(Boolean);
      if (!rows.length) break;
      for (const r of rows) seen.add(r.id);
      written += await upsert(rows);
      offset += rows.length;
      pages++;
      if (offset >= total) break;
    }
    return { seen, written, pages, total: total || 0 };
  }

  // ── Public operations ────────────────────────────────────────────────────
  // Historical backfill, oldest-first in monthly chunks so a failure part-way still leaves
  // the earlier months durably imported rather than rolling everything back.
  async function backfill({ startDate, endDate, maxPages }) {
    await initSchema();
    const chunks = monthChunks(startDate, endDate);
    const done = [];
    let written = 0;
    for (const [from, to] of chunks) {
      try {
        const r = await pullWindow(from, to, { maxPages });
        // Deletions are only reconciled for a window that completed. A window that threw
        // tells us nothing about absence.
        await reconcileDeletions(from, to, r.seen);
        written += r.written;
        done.push(from.slice(0, 7));
        const s = await state();
        await saveState({ windows: { ...s.windows, [from.slice(0, 7)]: { syncedAt: new Date(now()).toISOString(), count: r.total } },
          firstDate: s.firstDate && s.firstDate < from ? s.firstDate : from });
      } catch (err) {
        // Retain everything already imported and report where it stopped.
        await saveState({ lastError: { at: new Date(now()).toISOString(), message: err.message, window: from.slice(0, 7) } });
        return { written, months: done, stoppedAt: from.slice(0, 7), error: err.message };
      }
    }
    await saveState({ lastSyncAt: new Date(now()).toISOString(), lastError: null });
    return { written, months: done, stoppedAt: null, error: null };
  }

  // Incremental catch-up. Re-reads a trailing window rather than only "since last sync",
  // because a pending charge posts days later and an edit can land on an old date — both
  // change rows whose date is behind the watermark.
  async function incremental({ lookbackDays = 45, today } = {}) {
    await initSchema();
    const end = (today ? new Date(today) : new Date(now()));
    const start = new Date(end.getTime() - lookbackDays * 864e5);
    const from = start.toISOString().slice(0, 10), to = end.toISOString().slice(0, 10);
    try {
      const r = await pullWindow(from, to);
      const removed = await reconcileDeletions(from, to, r.seen);
      await saveState({ lastSyncAt: new Date(now()).toISOString(), lastError: null });
      return { written: r.written, removed, from, to, error: null };
    } catch (err) {
      await saveState({ lastError: { at: new Date(now()).toISOString(), message: err.message, window: `${from}..${to}` } });
      return { written: 0, removed: 0, from, to, error: err.message };
    }
  }

  async function syncCategories() {
    await initSchema();
    const cats = await live.categories();
    for (const c of cats) {
      await db.query(
        `INSERT INTO monarch_categories (id,name,group_id,group_name,group_type,system_category,is_disabled,synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, group_id=EXCLUDED.group_id,
           group_name=EXCLUDED.group_name, group_type=EXCLUDED.group_type,
           system_category=EXCLUDED.system_category, is_disabled=EXCLUDED.is_disabled, synced_at=NOW()`,
        [String(c.id), c.name || '', c.group?.id != null ? String(c.group.id) : null,
         c.group?.name || '', c.group?.type || '', c.systemCategory || '', !!c.isDisabled]);
    }
    return cats.length;
  }

  async function syncBudgets({ startDate, endDate }) {
    await initSchema();
    const { rows } = await live.budgets({ startDate, endDate });
    for (const b of rows) {
      await db.query(
        `INSERT INTO monarch_budgets (month,category_id,planned,actual,remaining,synced_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (month,category_id) DO UPDATE SET planned=EXCLUDED.planned,
           actual=EXCLUDED.actual, remaining=EXCLUDED.remaining, synced_at=NOW()`,
        [b.month, b.categoryId, b.planned, b.actual, b.remaining]);
    }
    return rows.length;
  }

  // ── Read ─────────────────────────────────────────────────────────────────
  // The user's override, where set, is what the accounting model sees — that is the whole
  // point of storing it separately from the provider's value.
  async function ledger({ startDate, endDate }) {
    const { rows } = await db.query(
      `SELECT id, to_char(date,'YYYY-MM-DD') AS date, amount::float8 AS amount, merchant, plaid_name,
              COALESCE(user_category_id, category_id) AS category_id, category_name,
              account_id, account_name, pending, hide_from_reports, is_recurring,
              is_split, tags, user_kind, to_char(synced_at,'YYYY-MM-DD"T"HH24:MI:SSZ') AS synced_at
         FROM monarch_transactions
        WHERE deleted_at IS NULL AND date >= $1 AND date <= $2
        ORDER BY date DESC, id`, [startDate, endDate]);
    return rows.map(r => ({
      id: r.id, date: r.date, amount: Number(r.amount), merchant: r.merchant, plaidName: r.plaid_name,
      categoryId: r.category_id, categoryName: r.category_name,
      accountId: r.account_id, accountName: r.account_name,
      pending: r.pending, hideFromReports: r.hide_from_reports,
      isRecurring: r.is_recurring, isSplitTransaction: r.is_split,
      tags: r.tags || [], userKind: r.user_kind || null, syncedAt: r.synced_at,
    }));
  }

  async function localCategories() {
    const { rows } = await db.query('SELECT id,name,group_id,group_name,group_type,system_category FROM monarch_categories WHERE is_disabled = FALSE');
    return rows.map(r => ({ id: r.id, name: r.name, systemCategory: r.system_category,
      group: { id: r.group_id, name: r.group_name, type: r.group_type } }));
  }

  // Freshness and history coverage, so every view can say what it is standing on rather than
  // implying the numbers are complete.
  async function status() {
    const s = await state();
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n,
              to_char(MIN(date),'YYYY-MM-DD') AS first_date,
              to_char(MAX(date),'YYYY-MM-DD') AS last_date,
              COUNT(*) FILTER (WHERE pending)::int AS pending,
              to_char(MAX(synced_at),'YYYY-MM-DD"T"HH24:MI:SSZ') AS last_row_sync
         FROM monarch_transactions WHERE deleted_at IS NULL`);
    const r = rows[0] || {};
    return {
      transactions: r.n || 0, firstDate: r.first_date || null, lastDate: r.last_date || null,
      pending: r.pending || 0, lastSyncAt: s.lastSyncAt || r.last_row_sync || null,
      monthsImported: Object.keys(s.windows || {}).sort(),
      lastError: s.lastError || null,
    };
  }

  async function setOverride(id, { userKind = null, userCategoryId = null, userNote = null }) {
    const { rows } = await db.query(
      `UPDATE monarch_transactions SET user_kind=$2, user_category_id=$3, user_note=$4
        WHERE id=$1 RETURNING id`, [String(id), userKind, userCategoryId, userNote]);
    return rows.length > 0;
  }

  return { initSchema, backfill, incremental, syncCategories, syncBudgets,
    ledger, localCategories, status, setOverride, upsert, reconcileDeletions, pullWindow, state };
}

// Split a date range into calendar-month windows, oldest first.
function monthChunks(startDate, endDate) {
  const out = [];
  const start = new Date(startDate + 'T00:00:00Z'), end = new Date(endDate + 'T00:00:00Z');
  let y = start.getUTCFullYear(), m = start.getUTCMonth();
  while (true) {
    const from = new Date(Date.UTC(y, m, 1)), to = new Date(Date.UTC(y, m + 1, 0));
    const lo = from < start ? start : from, hi = to > end ? end : to;
    if (lo > end) break;
    out.push([lo.toISOString().slice(0, 10), hi.toISOString().slice(0, 10)]);
    if (hi >= end) break;
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

module.exports = { createMonarchSync, monthChunks, SYNC_KEY };
