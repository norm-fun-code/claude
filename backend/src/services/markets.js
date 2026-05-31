// Markets snapshot for the Wealth tab: live index levels (S&P 500, NASDAQ) and
// a few top finance/markets headlines. All sources are public and best-effort —
// any failure degrades gracefully so the briefing never breaks.
const axios = require('axios');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

const INDICES = [
  { symbol: '^GSPC', stooq: '^spx', label: 'S&P 500' },
  { symbol: '^IXIC', stooq: '^ndq', label: 'NASDAQ' },
];

function quote(label, symbol, price, prev) {
  if (!Number.isFinite(price) || !Number.isFinite(prev)) throw new Error(`bad quote for ${symbol}`);
  const change = price - prev;
  return {
    label,
    symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePct: Math.round((prev ? (change / prev) * 100 : 0) * 100) / 100,
  };
}

// Primary: Yahoo Finance chart endpoint (real-time, no key). Latest price + prior close.
async function fetchYahoo({ symbol, label }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 8000 });
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`no data for ${symbol}`);
  return quote(label, symbol, meta.regularMarketPrice, meta.chartPreviousClose ?? meta.previousClose);
}

// Fallback: Stooq daily history CSV (very permissive, no key). Last two closes
// give the day's change. EOD rather than intraday, but reliable when Yahoo blocks.
async function fetchStooq({ stooq, symbol, label }) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 8000 });
  const lines = String(data).trim().split('\n').filter(Boolean);
  if (lines.length < 3) throw new Error(`stooq no data for ${stooq}`);
  const rows = lines.slice(1).map((l) => l.split(','));
  const close = (r) => parseFloat(r[4]); // Date,Open,High,Low,Close,Volume
  return quote(label, symbol, close(rows[rows.length - 1]), close(rows[rows.length - 2]));
}

async function fetchIndex(idx) {
  try {
    return await fetchYahoo(idx);
  } catch {
    return await fetchStooq(idx);
  }
}

async function fetchIndices() {
  const results = await Promise.allSettled(INDICES.map(fetchIndex));
  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
}

// Strip CDATA / HTML entities from an RSS field.
function clean(s) {
  return (s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// Is an RSS pubDate the current day in the given timezone?
function isToday(pubDate, tz) {
  if (!pubDate) return false;
  const d = new Date(pubDate);
  if (isNaN(d)) return false;
  const fmt = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(x);
  return fmt(d) === fmt(new Date());
}

// Minimal RSS parse — pull <item> title/link/pubDate. Avoids an XML dependency.
function parseRss(xml, source) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    const pubDate = clean((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (title) items.push({ title, url: link || null, source, pubDate });
  }
  return items;
}

const HEADLINE_FEEDS = [
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', source: 'WSJ Markets' },
  { url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', source: 'WSJ Business' },
];

async function fetchHeadlines(limit = 5) {
  const tz = process.env.TZ || 'America/New_York';
  const collected = [];
  for (const feed of HEADLINE_FEEDS) {
    try {
      const { data } = await axios.get(feed.url, { headers: { 'User-Agent': UA }, timeout: 8000 });
      collected.push(...parseRss(String(data), feed.source));
    } catch {
      // try the next feed
    }
  }
  if (!collected.length) return [];
  // Always newest-first by publish date, so the card shows the freshest stories
  // (preferring ones published today, then falling back to the most recent).
  const ts = (it) => {
    const d = new Date(it.pubDate);
    return isNaN(d) ? 0 : d.getTime();
  };
  collected.sort((a, b) => ts(b) - ts(a));
  const todays = collected.filter((it) => isToday(it.pubDate, tz));
  const pick = (todays.length ? todays : collected).slice(0, limit);
  return pick.map(({ title, url, source }) => ({ title, url, source }));
}

// Returns { indices: [...], headlines: [...] } — either may be empty.
async function fetchMarkets() {
  const [indices, headlines] = await Promise.all([fetchIndices(), fetchHeadlines()]);
  if (!indices.length && !headlines.length) return null;
  return { indices, headlines };
}

module.exports = { fetchMarkets };
