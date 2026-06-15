/**
 * NormOS Morning Briefing — Google Apps Script ("Gemini morning briefing").
 *
 * Architecture (mirrors the NormOS app): the LLM produces only CONTENT (as JSON);
 * this script renders all presentation deterministically, so layout is fully under
 * our control and nothing the model returns can break the design.
 *
 * Sections:
 *   - Reflection   : a random principle from a Google Doc + a 2-sentence insight.
 *   - Notion Wisdom: deep-crawls the Notion wisdom tree, quotes one complete
 *                    passage verbatim + a 2-sentence insight.
 *   - Newsletters  : dense, Daily-Upside-style summaries of inbox newsletters.
 *   - Urgent Inbox : real action items only.
 *   - Markets      : the app's market brief — live RSS feeds, 3-5 bullet brief.
 *   - Calendar     : today's events.
 *   - Workout      : today's plan + protein target (computed, not LLM).
 *
 * Insight voice matches the app: draw out the principle as lived wisdom, make it
 * land as universal guidance — no personal data, no job/calendar/finance refs.
 */

// ============================ CONFIG ============================
const GEMINI_API_KEY = 'INSERT'; // Paste your Gemini key here
const NOTION_API_KEY = 'insert'; // Paste your Notion Integration Secret here
const TARGET_EMAIL = 'normanc41@gmail.com';
const DOC_ID = '1nut0jXBKyK6nWTdfwRDwkkcq0_DejXSCW97UgbFUVtc'; // Native Google Doc of principles
const NOTION_PAGE_ID = '7c43faa67b284b8a900a3c98545e01b5';     // Wisdom parent page

// Editorial palette + type (WSJ / Morning Brew feel).
const STYLE = {
  ink: '#1a1a1a',
  body: '#2d2d2d',
  muted: '#6b7280',
  faint: '#9aa0a6',
  accent: '#1e3a5f',   // deep navy
  hair: '#e5e7eb',
  page: '#f4f4f2',
  serif: "Georgia, 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

// ============================ LLM ============================
function callGemini(systemText, promptText, opts) {
  opts = opts || {};
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' + GEMINI_API_KEY;
  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    systemInstruction: { parts: [{ text: systemText }] },
    generationConfig: {
      temperature: opts.temperature != null ? opts.temperature : 0.2,
      maxOutputTokens: opts.maxTokens || 8192,
    },
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  try {
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    if (json.error) { Logger.log('Gemini API error: ' + json.error.message); return null; }
    return json.candidates[0].content.parts[0].text;
  } catch (e) {
    Logger.log('Gemini call failed: ' + e.toString());
    return null;
  }
}

// Robustly pull a JSON object out of an LLM response (handles fences/prose).
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(s); } catch (e) {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return JSON.parse(s.slice(i, j + 1)); } catch (e2) { /* fall through */ }
    }
    return null;
  }
}

// ============================ NOTION (deep crawl) ============================
// Ports the app's listWisdomPages + fetchPageText: collect every wisdom page at
// any depth under the parent, pick one at random, read its full nested text.
const NOTION_MAX_ITER = 30;
const NOTION_MAX_PAGE_DEPTH = 4;
const NOTION_MAX_BLOCK_DEPTH = 6;

function notionGet(url) {
  const options = {
    method: 'get',
    headers: { Authorization: 'Bearer ' + NOTION_API_KEY, 'Notion-Version': '2022-06-28' },
    muteHttpExceptions: true,
  };
  return JSON.parse(UrlFetchApp.fetch(url, options).getContentText());
}

function collectWisdomPageIds(rootId, depth) {
  depth = depth || 0;
  const ids = [];
  if (depth > NOTION_MAX_PAGE_DEPTH) return ids;
  let cursor = null, iters = 0;
  do {
    let url = 'https://api.notion.com/v1/blocks/' + rootId + '/children?page_size=100';
    if (cursor) url += '&start_cursor=' + cursor;
    const res = notionGet(url);
    (res.results || []).forEach(function (block) {
      if (block.type === 'child_page') {
        ids.push(block.id);
        Array.prototype.push.apply(ids, collectWisdomPageIds(block.id, depth + 1));
      }
    });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && ++iters < NOTION_MAX_ITER);
  return ids;
}

function fetchNotionPageTextDeep(blockId, depth) {
  depth = depth || 0;
  if (depth > NOTION_MAX_BLOCK_DEPTH) return '';
  const lines = [];
  let cursor = null, iters = 0;
  do {
    let url = 'https://api.notion.com/v1/blocks/' + blockId + '/children?page_size=100';
    if (cursor) url += '&start_cursor=' + cursor;
    const res = notionGet(url);
    (res.results || []).forEach(function (block) {
      const type = block.type;
      const content = block[type];
      if (content && content.rich_text) {
        const text = content.rich_text.map(function (rt) { return rt.plain_text; }).join('').trim();
        if (text) {
          const isList = (type === 'bulleted_list_item' || type === 'numbered_list_item');
          lines.push(isList ? '• ' + text : text);
        }
      }
      if (block.has_children && type !== 'child_page' && type !== 'child_database') {
        const sub = fetchNotionPageTextDeep(block.id, depth + 1);
        if (sub) lines.push(sub);
      }
    });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && ++iters < NOTION_MAX_ITER);
  return lines.join('\n');
}

function getNotionWisdom() {
  try {
    const ids = collectWisdomPageIds(NOTION_PAGE_ID, 0);
    if (!ids.length) return '';
    const chosen = ids[Math.floor(Math.random() * ids.length)];
    return fetchNotionPageTextDeep(chosen, 0) || '';
  } catch (e) {
    Logger.log('Notion fetch failed: ' + e.toString());
    return '';
  }
}

// ============================ MARKETS (ported from app) ============================
const MARKET_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';
const MARKET_FEEDS = [
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', source: 'CNBC Markets' },
  { url: 'http://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC' },
];
const MARKET_BRIEF_SYSTEM =
  'You are a markets editor writing a concise daily brief for a busy investor.\n' +
  'From the provided stories, write 3-5 bullet points, each 2-3 sentences.\n' +
  '- Lead with what\'s moving markets today and why (indices, rates, big movers, macro).\n' +
  '- Be specific: cite numbers, companies, and drivers when present. Neutral tone, no hype.\n' +
  '- Group related stories; don\'t just restate headlines one by one.\n' +
  'Output ONLY Markdown bullets starting with "- ". No preamble, no headers.';

function cleanRss(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
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
  blocks.forEach(function (block) {
    const title = cleanRss((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const description = cleanRss((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]);
    const pubDate = cleanRss((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (title) items.push({ title: title, description: description, pubDate: pubDate, source: source });
  });
  return items;
}

function fetchMarketStories(limit, tz) {
  const collected = [];
  const opts = { method: 'get', headers: { 'User-Agent': MARKET_UA }, muteHttpExceptions: true };
  MARKET_FEEDS.forEach(function (feed) {
    try {
      const resp = UrlFetchApp.fetch(feed.url, opts);
      if (resp.getResponseCode() === 200) {
        Array.prototype.push.apply(collected, parseRss(resp.getContentText(), feed.source));
      }
    } catch (e) { /* try the next feed */ }
  });
  if (!collected.length) return [];

  const ms = function (it) { const d = new Date(it.pubDate); return isNaN(d.getTime()) ? 0 : d.getTime(); };
  collected.sort(function (a, b) { return ms(b) - ms(a); }); // newest first

  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const todays = collected.filter(function (it) {
    if (!it.pubDate) return false;
    const d = new Date(it.pubDate);
    if (isNaN(d.getTime())) return false;
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd') === today;
  });
  return (todays.length ? todays : collected).slice(0, limit);
}

// Returns the markets brief as Markdown bullets, or '' if unavailable.
function getMarketBrief(tz) {
  const stories = fetchMarketStories(12, tz);
  if (!stories.length) return '';
  const list = stories.map(function (s, i) {
    return (i + 1) + '. ' + s.title + (s.description ? ' — ' + s.description : '') + ' [' + s.source + ']';
  }).join('\n');
  const text = callGemini(
    MARKET_BRIEF_SYSTEM,
    'Today\'s market & finance stories:\n\n' + list + '\n\nWrite the brief.',
    { temperature: 0.3, maxTokens: 700 }
  );
  return (text && text.trim()) ? text.trim() : '';
}

// ============================ DATA GATHERERS ============================
function getRandomPrinciple() {
  try {
    const doc = DocumentApp.openById(DOC_ID);
    const fullText = doc.getBody().getText();
    const arr = fullText.split('\n').filter(function (p) { return p.trim().length > 30; });
    if (!arr.length) return 'Seek wisdom in all things.';
    return arr[Math.floor(Math.random() * arr.length)].trim();
  } catch (e) {
    return 'Seek wisdom in all things.';
  }
}

function getUnreadEmails() {
  const threads = GmailApp.search('is:unread in:inbox', 0, 15);
  return threads.map(function (thread) {
    const msg = thread.getMessages()[0];
    return {
      from: msg.getFrom(),
      subject: msg.getSubject(),
      body: msg.getPlainBody().substring(0, 15000),
    };
  });
}

function getTodaysEvents(date, tz) {
  const events = CalendarApp.getDefaultCalendar().getEventsForDay(date);
  return events.map(function (e) {
    return {
      time: e.isAllDayEvent() ? 'All day' : Utilities.formatDate(e.getStartTime(), tz, 'h:mm a'),
      title: e.getTitle(),
    };
  });
}

const WORKOUTS = {
  Sunday: { name: 'Strength — Pull', protein: '100–115g' },
  Monday: { name: 'Zone 2 Walk — 45 min, HR 135–145', protein: '70–85g' },
  Tuesday: { name: 'Recovery + Mobility', protein: '70–85g' },
  Wednesday: { name: 'Japanese Intervals — 45–55 min', protein: '70–85g' },
  Thursday: { name: 'Strength — Push', protein: '100–115g' },
  Friday: { name: 'Full Recovery', protein: '70–85g' },
  Saturday: { name: 'Zone 2 Walk — 45 min', protein: '70–85g' },
};

// ============================ CONTENT (LLM, JSON) ============================
const CONTENT_SYSTEM =
  'You are NormOS — a sharp, numerate chief of staff and financial analyst. ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary. ' +
  'Never invent a number, company, or fact not present in the source material.';

function buildContentPrompt(principle, notionText, emails) {
  const emailSection = emails.map(function (e, i) {
    return '--- Email ' + (i + 1) + ' ---\nFrom: ' + e.from + '\nSubject: ' + e.subject + '\nBody:\n' + e.body;
  }).join('\n\n');

  return 'SOURCE MATERIAL\n\n' +
    'Today\'s principle:\n"' + principle + '"\n\n' +
    'Notion wisdom:\n' + (notionText ? notionText.substring(0, 4000) : '(none)') + '\n\n' +
    'Unread emails (' + emails.length + ' threads):\n' + (emailSection || '(none)') + '\n\n' +
    '---\n\nReturn ONLY valid JSON with EXACTLY these fields:\n\n' +
    '{\n' +
    '  "quoteInsight": "Exactly 2 sentences drawing out the deeper idea or principle in the quote. First sentence: the core idea as lived wisdom. Second sentence: how it applies in practice as universal guidance. Speak to the human, not the day. Do NOT reference a job, profession, calendar, tasks, schedule, \'today\', or finances, and do NOT name any personal data.",\n' +
    '  "notionQuote": "The single most resonant COMPLETE sentence or passage from the Notion wisdom — quote it VERBATIM. Never a title, heading, or intro fragment that trails off (e.g. ending in a colon); never cut off mid-thought. Empty string if the Notion wisdom is empty.",\n' +
    '  "notionInsight": "Exactly 2 sentences drawing out the key idea in the SPECIFIC notionQuote you selected — the commentary MUST match that exact passage. Same voice and constraints as quoteInsight. Empty string if there is no notionQuote.",\n' +
    '  "newsletters": [\n' +
    '    { "name": "Sender", "title": "Edition or article title", "summary": "A dense 5-10 sentence paragraph summarizing the substance of THIS specific email. Extract every hard number, percentage, dollar amount, named company, person, and specific argument. Deep, factual, premium-newsletter style (e.g. The Daily Upside). No bullets, no filler." }\n' +
    '  ],\n' +
    '  "urgentEmails": [\n' +
    '    { "from": "Sender", "subject": "Subject", "action": "1-2 sentences: what action is needed and why it is time-sensitive." }\n' +
    '  ]\n' +
    '}\n\n' +
    'Rules:\n' +
    '- newsletters: include digests/publications (The Daily Upside, Morning Brew, Stratechery, Substacks); EXCLUDE personal email, receipts, order/shipping confirmations, calendar invites, and automated notifications. Never combine two newsletters. Empty array if none.\n' +
    '- urgentEmails: only emails where a real person expects a response or there is a deadline/decision needing input. Exclude newsletters, marketing, receipts, and notifications. Empty array if none.\n' +
    '- quoteInsight / notionInsight: first sentence is the core idea as lived wisdom; second makes it land as practical, universal guidance. Speak to the human, not the day. Never name personal data; never reference job, profession, calendar, tasks, schedule, "today", or finances.';
}

function getContent(principle, notionText, emails) {
  const raw = callGemini(CONTENT_SYSTEM, buildContentPrompt(principle, notionText, emails), { temperature: 0.2, maxTokens: 8192 });
  const p = extractJson(raw) || {};
  return {
    quoteInsight: typeof p.quoteInsight === 'string' ? p.quoteInsight : '',
    notionQuote: typeof p.notionQuote === 'string' ? p.notionQuote.trim() : '',
    notionInsight: typeof p.notionInsight === 'string' ? p.notionInsight : '',
    newsletters: Array.isArray(p.newsletters) ? p.newsletters : [],
    urgentEmails: Array.isArray(p.urgentEmails) ? p.urgentEmails : [],
  };
}

// ============================ RENDER (deterministic) ============================
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sectionLabel(text) {
  return '<div style="font-family:' + STYLE.serif + '; font-size:12px; font-weight:700; letter-spacing:1.5px; ' +
    'text-transform:uppercase; color:' + STYLE.accent + '; border-top:2px solid ' + STYLE.accent + '; ' +
    'padding-top:8px; margin:36px 0 16px;">' + esc(text) + '</div>';
}

function insightBlock(label, quote, insight) {
  let html = '<div style="border-left:3px solid ' + STYLE.accent + '; padding:2px 0 2px 16px; margin:0 0 14px;">' +
    '<div style="font-family:' + STYLE.serif + '; font-style:italic; font-size:17px; line-height:1.5; color:' + STYLE.ink + ';">' +
    esc(quote) + '</div></div>';
  if (insight) {
    html += '<div style="font-family:' + STYLE.sans + '; font-size:11px; font-weight:700; letter-spacing:1px; ' +
      'text-transform:uppercase; color:' + STYLE.muted + '; margin-bottom:5px;">The key idea</div>' +
      '<div style="font-family:' + STYLE.sans + '; font-size:15px; line-height:1.65; color:' + STYLE.body + ';">' +
      esc(insight) + '</div>';
  }
  return html;
}

function newslettersHtml(list) {
  if (!list.length) return emptyNote('No newsletters in your inbox today.');
  return list.map(function (n) {
    return '<div style="margin-bottom:24px;">' +
      '<div style="font-family:' + STYLE.sans + '; font-size:11px; font-weight:700; letter-spacing:1px; ' +
      'text-transform:uppercase; color:' + STYLE.accent + '; margin-bottom:3px;">' + esc(n.name) + '</div>' +
      '<div style="font-family:' + STYLE.serif + '; font-size:18px; font-weight:700; line-height:1.3; ' +
      'color:' + STYLE.ink + '; margin-bottom:7px;">' + esc(n.title) + '</div>' +
      '<div style="font-family:' + STYLE.sans + '; font-size:15px; line-height:1.7; color:' + STYLE.body + ';">' +
      esc(n.summary) + '</div></div>';
  }).join('');
}

function urgentHtml(list) {
  if (!list.length) return emptyNote('Inbox clear. No urgent actions required.');
  return list.map(function (u) {
    return '<div style="margin-bottom:14px;">' +
      '<div style="font-family:' + STYLE.sans + '; font-size:15px; font-weight:700; color:' + STYLE.ink + ';">' + esc(u.subject) + '</div>' +
      '<div style="font-family:' + STYLE.sans + '; font-size:12px; color:' + STYLE.muted + '; margin:1px 0 4px;">' + esc(u.from) + '</div>' +
      '<div style="font-family:' + STYLE.sans + '; font-size:14px; line-height:1.6; color:' + STYLE.body + ';">' + esc(u.action) + '</div></div>';
  }).join('');
}

function marketsHtml(briefMarkdown) {
  if (!briefMarkdown) return emptyNote('Market brief unavailable today.');
  const items = briefMarkdown.split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return l.indexOf('- ') === 0 || l.indexOf('* ') === 0; })
    .map(function (l) {
      const t = esc(l.replace(/^[-*]\s+/, '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      return '<li style="margin-bottom:11px; line-height:1.65;">' + t + '</li>';
    }).join('');
  return '<ul style="font-family:' + STYLE.sans + '; font-size:15px; color:' + STYLE.body + '; padding-left:18px; margin:0;">' + items + '</ul>';
}

function calendarHtml(events) {
  if (!events.length) {
    return '<div style="font-family:' + STYLE.sans + '; font-size:15px; color:' + STYLE.muted + '; font-style:italic;">' +
      'No events today — a clear day. Make it count.</div>';
  }
  const rows = events.map(function (e) {
    return '<li style="margin-bottom:6px; line-height:1.5;"><strong style="color:' + STYLE.ink + ';">' +
      esc(e.time) + '</strong>&nbsp;&nbsp;' + esc(e.title) + '</li>';
  }).join('');
  return '<ul style="font-family:' + STYLE.sans + '; font-size:15px; color:' + STYLE.body + '; list-style:none; padding:0; margin:0;">' + rows + '</ul>';
}

function workoutHtml(day) {
  const w = WORKOUTS[day] || { name: 'Rest', protein: '70–85g' };
  return '<div style="border:1px solid ' + STYLE.hair + '; border-radius:8px; padding:18px; background:#fafafa;">' +
    '<div style="font-family:' + STYLE.sans + '; font-size:16px; font-weight:700; color:' + STYLE.ink + '; margin-bottom:6px;">' +
    esc(day) + ' &middot; ' + esc(w.name) + '</div>' +
    '<div style="font-family:' + STYLE.sans + '; font-size:13.5px; color:' + STYLE.muted + '; margin-bottom:4px;">' +
    '<strong>Protein:</strong> ' + esc(w.protein) + '</div>' +
    '<div style="font-family:' + STYLE.sans + '; font-size:13.5px; color:' + STYLE.muted + '; font-style:italic;">' +
    'Check your HRV first — green: train; yellow: downgrade; red: mobility or a walk.</div></div>';
}

function emptyNote(text) {
  return '<div style="font-family:' + STYLE.sans + '; font-size:14px; color:' + STYLE.muted + '; font-style:italic;">' + esc(text) + '</div>';
}

function renderEmail(parts) {
  const masthead =
    '<div style="text-align:center; padding-bottom:18px; border-bottom:3px double ' + STYLE.accent + ';">' +
    '<div style="font-family:' + STYLE.serif + '; font-size:30px; font-weight:700; letter-spacing:0.5px; color:' + STYLE.ink + ';">Morning Briefing</div>' +
    '<div style="font-family:' + STYLE.sans + '; font-size:12px; letter-spacing:2.5px; text-transform:uppercase; color:' + STYLE.muted + '; margin-top:8px;">' +
    esc(parts.dateString) + '</div></div>';

  const greeting =
    '<div style="font-family:' + STYLE.sans + '; font-size:16px; line-height:1.6; color:' + STYLE.ink + '; margin:24px 0 0;">' +
    'Good morning, Norm — show up with joy, presence, and courage today.</div>';

  let body = masthead + greeting;
  body += sectionLabel('Reflection') + insightBlock('Reflection', parts.principle, parts.content.quoteInsight);
  if (parts.content.notionQuote) {
    body += sectionLabel('Notion Wisdom') + insightBlock('Notion Wisdom', parts.content.notionQuote, parts.content.notionInsight);
  }
  body += sectionLabel('Newsletters') + newslettersHtml(parts.content.newsletters);
  body += sectionLabel('Urgent Inbox') + urgentHtml(parts.content.urgentEmails);
  body += sectionLabel('Markets') + marketsHtml(parts.marketBrief);
  body += sectionLabel('Calendar — Today') + calendarHtml(parts.events);
  body += sectionLabel('Workout') + workoutHtml(parts.day);

  const footer =
    '<div style="margin-top:40px; padding-top:16px; border-top:1px solid ' + STYLE.hair + '; ' +
    'font-family:' + STYLE.sans + '; font-size:11px; color:' + STYLE.faint + '; text-align:center;">' +
    'NormOS &middot; ' + esc(parts.timeString) + '</div>';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin:0; padding:0; background:' + STYLE.page + ';">' +
    '<div style="max-width:620px; margin:0 auto; background:#ffffff; padding:34px 30px 42px;">' +
    body + footer + '</div></body></html>';
}

// ============================ ENTRY POINT ============================
function sendMorningBriefing() {
  const date = new Date();
  const tz = Session.getScriptTimeZone();
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getDay()];
  const dateString = Utilities.formatDate(date, tz, 'EEEE, MMMM d, yyyy');
  const timeString = 'Generated ' + Utilities.formatDate(date, tz, 'h:mm a');
  const subject = '☀️ Morning Briefing — ' + Utilities.formatDate(date, tz, 'MMMM d, yyyy');

  // Gather source material.
  const principle = getRandomPrinciple();
  const notionText = getNotionWisdom();
  const emails = getUnreadEmails();
  const events = getTodaysEvents(date, tz);
  const marketBrief = getMarketBrief(tz); // separate markets-editor call, like the app

  // LLM content (JSON) → deterministic render.
  const content = getContent(principle, notionText, emails);

  const html = renderEmail({
    dateString: dateString,
    timeString: timeString,
    day: day,
    principle: principle,
    content: content,
    marketBrief: marketBrief,
    events: events,
  });

  GmailApp.sendEmail(TARGET_EMAIL, subject, 'Your morning briefing is best viewed in an HTML-capable client.', { htmlBody: html });
  Logger.log('Email sent successfully.');
}
