import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createMonarchSync, monthChunks } = require('../monarch-sync.js');
const { mapTransaction } = require('../monarch-live.js');

// A small stand-in for the Postgres calls this module makes. It implements the specific
// statements rather than SQL generally — enough to exercise idempotency, pending→posted,
// deletions and override preservation, which is what actually needs proving.
function fakeDb() {
  const tx = new Map();       // id -> row
  const cats = new Map();
  const budgets = new Map();
  const kv = new Map();
  return {
    tx, kv,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX')) return { rows: [] };
      if (s.startsWith('SELECT data FROM oauth_tokens')) {
        const v = kv.get(params[0]); return { rows: v ? [{ data: v }] : [] };
      }
      if (s.startsWith('INSERT INTO oauth_tokens')) { kv.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
      if (s.startsWith('INSERT INTO monarch_transactions')) {
        const [id, date, amount, merchant, plaid, notes, catId, catName, acctId, acctName,
          pending, hide, recurring, split, tags, updatedAt] = params;
        const prev = tx.get(id);
        tx.set(id, {
          id, date, amount, merchant, plaid_name: plaid, notes,
          category_id: catId, category_name: catName, account_id: acctId, account_name: acctName,
          pending, hide_from_reports: hide, is_recurring: recurring, is_split: split,
          tags: JSON.parse(tags), provider_updated_at: updatedAt,
          synced_at: new Date().toISOString(), deleted_at: null,
          // preserved across upserts — the DO UPDATE list deliberately omits these
          user_kind: prev?.user_kind ?? null,
          user_category_id: prev?.user_category_id ?? null,
          user_note: prev?.user_note ?? null,
        });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE monarch_transactions SET deleted_at')) {
        const [from, to, ids] = params; const hit = [];
        for (const r of tx.values()) {
          if (r.deleted_at === null && r.date >= from && r.date <= to && !ids.includes(r.id)) {
            r.deleted_at = new Date().toISOString(); hit.push({ id: r.id });
          }
        }
        return { rows: hit };
      }
      if (s.startsWith('UPDATE monarch_transactions SET user_kind')) {
        const [id, kind, catId, note] = params; const r = tx.get(id);
        if (!r) return { rows: [] };
        r.user_kind = kind; r.user_category_id = catId; r.user_note = note;
        return { rows: [{ id }] };
      }
      if (s.startsWith('SELECT id, to_char(date')) {
        const [from, to] = params;
        return { rows: [...tx.values()].filter(r => !r.deleted_at && r.date >= from && r.date <= to)
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .map(r => ({ ...r, category_id: r.user_category_id ?? r.category_id, amount: r.amount })) };
      }
      if (s.startsWith('SELECT COUNT(*)::int AS n')) {
        const live = [...tx.values()].filter(r => !r.deleted_at);
        const dates = live.map(r => r.date).sort();
        return { rows: [{ n: live.length, first_date: dates[0] || null, last_date: dates[dates.length - 1] || null,
          pending: live.filter(r => r.pending).length, last_row_sync: null }] };
      }
      if (s.startsWith('INSERT INTO monarch_categories')) { cats.set(params[0], params); return { rows: [] }; }
      if (s.startsWith('SELECT id,name,group_id')) {
        return { rows: [...cats.values()].map(p => ({ id: p[0], name: p[1], group_id: p[2], group_name: p[3], group_type: p[4], system_category: p[5] })) };
      }
      if (s.startsWith('INSERT INTO monarch_budgets')) { budgets.set(params[0] + '|' + params[1], params); return { rows: [] }; }
      throw new Error('unhandled SQL: ' + s.slice(0, 70));
    },
  };
}

// A fake Monarch that pages, so pagination is exercised rather than assumed.
function fakeLive(rows, { pageSize = 2, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async transactionsPage({ startDate, endDate, offset = 0 }) {
      calls.push({ startDate, endDate, offset });
      if (fail && fail(startDate)) throw new Error('Monarch could not return transactions.');
      const inWindow = rows.filter(r => r.date >= startDate && r.date <= endDate);
      return { totalCount: inWindow.length, results: inWindow.slice(offset, offset + pageSize) };
    },
    async categories() { return [{ id: '1', name: 'Groceries', group: { id: 'g', name: 'Food', type: 'expense' } }]; },
    async budgets() { return { rows: [{ month: '2026-03', categoryId: '1', planned: 800, actual: 700, remaining: 100 }], groups: [] }; },
  };
}

const raw = (id, over = {}) => mapTransaction({
  id, date: '2026-03-05', amount: -100, category: { id: '1', name: 'Groceries' },
  account: { id: 'a1', displayName: 'Chase' }, merchant: { id: 'm', name: 'Store' },
  pending: false, updatedAt: '2026-03-06T00:00:00Z', tags: [], ...over,
});

describe('monthChunks', () => {
  it('splits a range into calendar months, oldest first', () => {
    expect(monthChunks('2026-01-15', '2026-03-10')).toEqual([
      ['2026-01-15', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-10'],
    ]);
  });
  it('handles a range inside one month', () => {
    expect(monthChunks('2026-03-05', '2026-03-09')).toEqual([['2026-03-05', '2026-03-09']]);
  });
});

describe('transaction sync', () => {
  let db, sync;
  const setup = (rows, opts) => { db = fakeDb(); sync = createMonarchSync({ db, live: fakeLive(rows, opts) }); };

  it('pages through a window rather than reading only the first page', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => raw('t' + i));
    setup(rows);
    const r = await sync.pullWindow('2026-03-01', '2026-03-31');
    expect(r.written).toBe(5);
    expect(r.pages).toBeGreaterThan(1);
    expect(db.tx.size).toBe(5);
  });

  it('is idempotent: syncing the same window twice changes nothing', async () => {
    setup([raw('t1'), raw('t2')]);
    await sync.pullWindow('2026-03-01', '2026-03-31');
    const after1 = [...db.tx.values()].map(r => ({ ...r, synced_at: null }));
    await sync.pullWindow('2026-03-01', '2026-03-31');
    const after2 = [...db.tx.values()].map(r => ({ ...r, synced_at: null }));
    expect(db.tx.size).toBe(2);
    expect(after2).toEqual(after1);
  });

  it('reconciles a pending charge into its posted form in place', async () => {
    setup([raw('t1', { pending: true, amount: -100, date: '2026-03-05' })]);
    await sync.pullWindow('2026-03-01', '2026-03-31');
    expect(db.tx.get('t1').pending).toBe(true);
    // Same id comes back settled, with a corrected amount and date
    sync = createMonarchSync({ db, live: fakeLive([raw('t1', { pending: false, amount: -104.25, date: '2026-03-07' })]) });
    await sync.pullWindow('2026-03-01', '2026-03-31');
    expect(db.tx.size).toBe(1);              // updated, not duplicated
    expect(db.tx.get('t1').pending).toBe(false);
    expect(db.tx.get('t1').amount).toBe(-104.25);
    expect(db.tx.get('t1').date).toBe('2026-03-07');
  });

  it('soft-deletes rows the provider removed, but only inside the window it re-read', async () => {
    setup([raw('t1'), raw('t2'), raw('old', { date: '2026-01-09' })]);
    await sync.backfill({ startDate: '2026-01-01', endDate: '2026-03-31' });
    expect(db.tx.size).toBe(3);
    // t2 disappears upstream; re-sync only March
    sync = createMonarchSync({ db, live: fakeLive([raw('t1')]) });
    const r = await sync.pullWindow('2026-03-01', '2026-03-31');
    const removed = await sync.reconcileDeletions('2026-03-01', '2026-03-31', r.seen);
    expect(removed).toBe(1);
    expect(db.tx.get('t2').deleted_at).not.toBeNull();
    expect(db.tx.get('old').deleted_at).toBeNull(); // untouched — outside the window
  });

  it('resurrects a row that reappears instead of leaving it deleted', async () => {
    setup([raw('t1')]);
    await sync.pullWindow('2026-03-01', '2026-03-31');
    await sync.reconcileDeletions('2026-03-01', '2026-03-31', new Set());
    expect(db.tx.get('t1').deleted_at).not.toBeNull();
    await sync.pullWindow('2026-03-01', '2026-03-31');
    expect(db.tx.get('t1').deleted_at).toBeNull();
  });

  it('never overwrites a user categorisation', async () => {
    setup([raw('t1')]);
    await sync.pullWindow('2026-03-01', '2026-03-31');
    await sync.setOverride('t1', { userKind: 'transfer', userCategoryId: '99' });
    // provider re-categorises it; sync runs again
    sync = createMonarchSync({ db, live: fakeLive([raw('t1', { category: { id: '7', name: 'Shopping' } })]) });
    await sync.pullWindow('2026-03-01', '2026-03-31');
    const row = db.tx.get('t1');
    expect(row.category_id).toBe('7');        // provider value refreshed
    expect(row.user_category_id).toBe('99');  // …the user's kept
    expect(row.user_kind).toBe('transfer');
    const [led] = await sync.ledger({ startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(led.categoryId).toBe('99');        // and the override is what accounting sees
    expect(led.userKind).toBe('transfer');
  });

  it('retains everything imported when a later window fails', async () => {
    const rows = [raw('jan', { date: '2026-01-10' }), raw('feb', { date: '2026-02-10' })];
    db = fakeDb();
    sync = createMonarchSync({ db, live: fakeLive(rows, { fail: s => s.startsWith('2026-02') }) });
    const r = await sync.backfill({ startDate: '2026-01-01', endDate: '2026-02-28' });
    expect(r.error).toMatch(/could not return transactions/i);
    expect(r.stoppedAt).toBe('2026-02');
    expect(r.months).toEqual(['2026-01']);
    expect(db.tx.get('jan')).toBeTruthy();     // last-good data retained
    const s = await sync.state();
    expect(s.lastError.window).toBe('2026-02');
  });

  it('does not delete anything on a window that errored', async () => {
    db = fakeDb();
    sync = createMonarchSync({ db, live: fakeLive([raw('t1')]) });
    await sync.backfill({ startDate: '2026-03-01', endDate: '2026-03-31' });
    sync = createMonarchSync({ db, live: fakeLive([raw('t1')], { fail: () => true }) });
    await sync.incremental({ today: '2026-03-20' });
    expect(db.tx.get('t1').deleted_at).toBeNull(); // a failed read is not evidence of absence
  });

  it('re-reads a trailing window so a late-posting charge is caught', async () => {
    db = fakeDb();
    const live = fakeLive([raw('t1')]);
    sync = createMonarchSync({ db, live });
    await sync.incremental({ lookbackDays: 45, today: '2026-04-01' });
    const { startDate, endDate } = live.calls[0];
    expect(endDate).toBe('2026-04-01');
    expect(new Date(endDate) - new Date(startDate)).toBe(45 * 864e5);
  });

  it('reports freshness and history coverage', async () => {
    setup([raw('t1', { date: '2026-01-10' }), raw('t2', { date: '2026-03-05', pending: true })]);
    await sync.backfill({ startDate: '2026-01-01', endDate: '2026-03-31' });
    const st = await sync.status();
    expect(st.transactions).toBe(2);
    expect(st.firstDate).toBe('2026-01-10');
    expect(st.lastDate).toBe('2026-03-05');
    expect(st.pending).toBe(1);
    expect(st.monthsImported).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(st.lastError).toBeNull();
  });

  it('syncs categories and budgets through the same path', async () => {
    setup([]);
    expect(await sync.syncCategories()).toBe(1);
    const cats = await sync.localCategories();
    expect(cats[0].group.type).toBe('expense'); // the field the accounting model needs
    expect(await sync.syncBudgets({ startDate: '2026-03-01', endDate: '2026-03-31' })).toBe(1);
  });
});

describe('incomplete imports preserve saved history',()=>{
  for(const mode of ['early end','duplicate page','page cap'])it(mode,async()=>{
    const db=fakeDb();let broken=false;
    const live={async transactionsPage({offset}){
      if(!broken)return{totalCount:2,results:[raw('one'),raw('two')]};
      return{totalCount:2,results:offset?(mode==='duplicate page'?[raw('one')]:[]):[raw('one')]};
    }};
    const sync=createMonarchSync({db,live});
    await sync.backfill({startDate:'2026-03-01',endDate:'2026-03-31'});
    broken=true;
    const result=await sync.backfill({startDate:'2026-03-01',endDate:'2026-03-31',maxPages:mode==='page cap'?1:200});
    expect(result.error).toBeTruthy();expect(db.tx.get('two').deleted_at).toBe(null);
    expect(result.months).toEqual([]);
  });
});
