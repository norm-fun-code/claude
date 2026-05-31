// Daily market brief for the Wealth tab: pulls the day's top market/finance
// stories from live RSS feeds and has Claude synthesize them into a few tight
// bullets. Index levels are fetched on-device (datacenter IPs are blocked), so
// this service is just the news brief. Best-effort — degrades to null.
const axios = require('axios');
const llm = require('../llm');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

// Live, market-focused feeds (WSJ/Barron's RSS are defunct).
const FEEDS = [
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', source: 'CNBC Markets' },
  { url: 'http://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC' },
];

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

function parseRss(xml, source) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    const description = clean((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]);
    const pubDate = clean((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (title) items.push({ title, url: link || null, description, pubDate, source });
  }
  return items;
}

function isToday(pubDate, tz) {
  if (!pubDate) return false;
  const d = new Date(pubDate);
  if (isNaN(d)) return false;
  const fmt = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(x);
  return fmt(d) === fmt(new Date());
}

async function fetchStories(limit = 12) {
  const tz = process.env.TZ || 'America/New_York';
  const collected = [];
  for (const feed of FEEDS) {
    try {
      const { data } = await axios.get(feed.url, { headers: { 'User-Agent': UA }, timeout: 8000 });
      collected.push(...parseRss(String(data), feed.source));
    } catch {
      // try the next feed
    }
  }
  if (!collected.length) return [];
  const ts = (it) => {
    const d = new Date(it.pubDate);
    return isNaN(d) ? 0 : d.getTime();
  };
  collected.sort((a, b) => ts(b) - ts(a)); // newest first
  const todays = collected.filter((it) => isToday(it.pubDate, tz));
  return (todays.length ? todays : collected).slice(0, limit);
}

const BRIEF_SYSTEM = `You are a markets editor writing a concise daily brief for a busy investor.
From the provided stories, write 3-5 bullet points, each 2-3 sentences.
- Lead with what's moving markets today and why (indices, rates, big movers, macro).
- Be specific: cite numbers, companies, and drivers when present. Neutral tone, no hype.
- Group related stories; don't just restate headlines one by one.
Output ONLY Markdown bullets starting with "- ". No preamble, no headers.`;

async function generateBrief(stories) {
  if (!stories.length) return null;
  const list = stories
    .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''} [${s.source}]`)
    .join('\n');
  try {
    const text = await llm.generateText({
      system: BRIEF_SYSTEM,
      prompt: `Today's market & finance stories:\n\n${list}\n\nWrite the brief.`,
      temperature: 0.3,
      maxTokens: 700,
    });
    return (text || '').trim() || null;
  } catch (err) {
    console.error('[markets] brief generation failed:', err.message);
    return null;
  }
}

// Returns { brief, sources } — brief is Markdown bullets; sources are the
// stories it drew on (for attribution + tap-through). Null if nothing loaded.
async function fetchMarkets() {
  const stories = await fetchStories();
  if (!stories.length) return null;
  const brief = await generateBrief(stories);
  if (!brief) return null;
  return {
    brief,
    sources: stories.slice(0, 5).map(({ title, url, source }) => ({ title, url, source })),
  };
}

module.exports = { fetchMarkets };
