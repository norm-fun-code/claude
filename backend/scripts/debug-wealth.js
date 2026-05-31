#!/usr/bin/env node
// Prints month-by-month category spend so we can see why "vs usual" insights
// do/don't fire. Run on the server's DB:  node scripts/debug-wealth.js
const documents = require('../src/store/documents');

(async () => {
  const rows = await documents.monthlyCategorySpend({ months: 5 });
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const cats = [...new Set(rows.map((r) => r.category))];
  const get = (c, m) => rows.find((r) => r.category === c && r.month === m)?.spend || 0;

  const current = months[months.length - 1];
  const priors = months.slice(0, -1);
  console.log('Months:', months.join('  '));
  console.log('Current month:', current, '\n');

  const out = cats.map((c) => {
    const cur = get(c, current);
    const pr = priors.map((m) => get(c, m)).filter((v) => v > 0);
    const avg = pr.length ? pr.reduce((a, b) => a + b, 0) / pr.length : 0;
    const ratio = avg ? cur / avg : 0;
    return { c, cur, avg, ratio, byMonth: months.map((m) => Math.round(get(c, m))) };
  }).filter((x) => x.cur > 0 || x.avg > 0)
    .sort((a, b) => b.cur - a.cur);

  for (const x of out) {
    console.log(
      `${x.c.padEnd(22)} cur $${String(Math.round(x.cur)).padStart(6)}  avg $${String(Math.round(x.avg)).padStart(6)}  ` +
      `${x.ratio ? (x.ratio).toFixed(2) + 'x' : '   -'}   [${x.byMonth.join(', ')}]`
    );
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
