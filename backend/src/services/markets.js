// Markets snapshot for the Wealth tab: live index levels (S&P 500, NASDAQ) and
// a few top finance/markets headlines. All sources are public and best-effort —
// any failure degrades gracefully so the briefing never breaks.
const axios = require('axios');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

const INDICES = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'NASDAQ' },
];

// Yahoo Finance chart endpoint — no key required. Returns the latest price and
// the prior close, from which we derive the day's change.
async function fetchIndex({ symbol, label }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 8000,
  });
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`no data for ${symbol}`);
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  if (!Number.isFinite(price) || !Number.isFinite(prev)) throw new Error(`bad quote for ${symbol}`);
  const change = price - prev;
  const changePct = prev ? (change / prev) * 100 : 0;
  return {
    label,
    symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
  };
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

// Minimal RSS parse — pull <item> titles + links. Avoids an XML dependency.
function parseRss(xml, source, max) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    if (title) items.push({ title, url: link || null, source });
    if (items.length >= max) break;
  }
  return items;
}

const HEADLINE_FEEDS = [
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', source: 'WSJ Markets' },
  { url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', source: 'WSJ Business' },
];

async function fetchHeadlines(limit = 5) {
  for (const feed of HEADLINE_FEEDS) {
    try {
      const { data } = await axios.get(feed.url, { headers: { 'User-Agent': UA }, timeout: 8000 });
      const items = parseRss(String(data), feed.source, limit);
      if (items.length) return items;
    } catch {
      // try the next feed
    }
  }
  return [];
}

// Returns { indices: [...], headlines: [...] } — either may be empty.
async function fetchMarkets() {
  const [indices, headlines] = await Promise.all([fetchIndices(), fetchHeadlines()]);
  if (!indices.length && !headlines.length) return null;
  return { indices, headlines };
}

module.exports = { fetchMarkets };
