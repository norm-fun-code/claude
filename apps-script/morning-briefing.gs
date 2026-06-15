// NormOS Morning Briefing — Google Apps Script
//
// Sends the daily briefing email. Three sections now mirror how the NormOS app
// surfaces them:
//   - Newsletters: name + edition title + a dense, Daily-Upside-style summary
//     that extracts every named company, number, and dollar amount. Strict
//     include/exclude filter (digests in; receipts/notifications/personal out).
//   - Quote: draw out the deeper PRINCIPLE, then land it for where Norm is now.
//   - Notion: quote the single most resonant COMPLETE passage VERBATIM (never a
//     heading or a colon-fragment), then commentary that matches that passage.
//   - Market Brief: EXACTLY what the app's markets card shows — live RSS feeds
//     (CNBC Markets, MarketWatch, CNBC), today's stories, a 3-5 bullet brief in
//     a markets-editor voice, plus a SOURCES list. (Ported from backend markets.js.)

const GEMINI_API_KEY = 'INSERT'; // Paste your Gemini key here
const NOTION_API_KEY = 'insert'; // Paste your Notion Integration Secret here
const TARGET_EMAIL = 'normanc41@gmail.com';
const DOC_ID = '1nut0jXBKyK6nWTdfwRDwkkcq0_DejXSCW97UgbFUVtc'; // Ensure it is a native Google Doc!
const NOTION_PAGE_ID = '7c43faa67b284b8a900a3c98545e01b5';

// ---- Shared Gemini caller ----
function callGemini(systemText, promptText, opts) {
  opts = opts || {};
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    "contents": [{ "parts": [{ "text": promptText }] }],
    "systemInstruction": { "parts": [{ "text": systemText }] },
    "generationConfig": {
      "temperature": opts.temperature != null ? opts.temperature : 0.2,
      "maxOutputTokens": opts.maxTokens || 8192
    }
  };
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  try {
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    if (json.error) { Logger.log("API Error: " + json.error.message); return null; }
    return json.candidates[0].content.parts[0].text;
  } catch (e) {
    Logger.log("Gemini call failed: " + e.toString());
    return null;
  }
}

// ---- NOTION HELPERS ----
// Ports the app's deep crawl (listWisdomPages + fetchPageText): collect EVERY
// wisdom page at any depth under the parent, pick one at random, then read its
// FULL text — recursing into nested blocks (toggles, columns, nested lists) but
// treating sub-pages as their own entries in the pool (like the app does).
const NOTION_MAX_ITER = 30;     // pagination safety cap (100 items/page = 3,000)
const NOTION_MAX_PAGE_DEPTH = 4; // how deep to walk the sub-page tree
const NOTION_MAX_BLOCK_DEPTH = 6; // how deep to recurse into nested blocks

function notionGet(url, apiKey) {
  const options = {
    method: 'get',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Notion-Version': '2022-06-28' },
    muteHttpExceptions: true
  };
  return JSON.parse(UrlFetchApp.fetch(url, options).getContentText());
}

// Walk the sub-page tree from rootId, collecting child_page IDs at every depth.
// Scoped to the parent's subtree (no workspace-wide search), so only your wisdom
// pages are ever in the pool.
function collectWisdomPageIds(rootId, apiKey, depth) {
  depth = depth || 0;
  const ids = [];
  if (depth > NOTION_MAX_PAGE_DEPTH) return ids;
  let cursor = null, iters = 0;
  do {
    let url = `https://api.notion.com/v1/blocks/${rootId}/children?page_size=100`;
    if (cursor) url += `&start_cursor=${cursor}`;
    const res = notionGet(url, apiKey);
    (res.results || []).forEach(block => {
      if (block.type === 'child_page') {
        ids.push(block.id);
        // Recurse to find sub-pages nested under this page.
        Array.prototype.push.apply(ids, collectWisdomPageIds(block.id, apiKey, depth + 1));
      }
    });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && ++iters < NOTION_MAX_ITER);
  return ids;
}

// Flatten the full text of one page, recursing into nested blocks (but NOT into
// child pages/databases — those are separate entries in the pool). One line per
// block; list items prefixed with "• " so the LLM gets well-formed passages.
function fetchNotionPageTextDeep(blockId, apiKey, depth) {
  depth = depth || 0;
  if (depth > NOTION_MAX_BLOCK_DEPTH) return '';
  const lines = [];
  let cursor = null, iters = 0;
  do {
    let url = `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`;
    if (cursor) url += `&start_cursor=${cursor}`;
    const res = notionGet(url, apiKey);
    (res.results || []).forEach(block => {
      const type = block.type;
      const content = block[type];
      if (content && content.rich_text) {
        const text = content.rich_text.map(rt => rt.plain_text).join('').trim();
        if (text) {
          const isList = (type === 'bulleted_list_item' || type === 'numbered_list_item');
          lines.push(isList ? `• ${text}` : text);
        }
      }
      if (block.has_children && type !== 'child_page' && type !== 'child_database') {
        const sub = fetchNotionPageTextDeep(block.id, apiKey, depth + 1);
        if (sub) lines.push(sub);
      }
    });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && ++iters < NOTION_MAX_ITER);
  return lines.join('\n');
}

function getRandomNotionWisdom(rootId, apiKey) {
  try {
    const ids = collectWisdomPageIds(rootId, apiKey, 0);
    if (!ids.length) return "No child pages found in Notion.";
    const chosen = ids[Math.floor(Math.random() * ids.length)];
    const text = fetchNotionPageTextDeep(chosen, apiKey, 0);
    return text || "No readable text found in the selected Notion page.";
  } catch (e) {
    return "Could not fetch Notion data: " + e.toString();
  }
}

// ---- MARKET BRIEF (ported from backend src/services/markets.js) ----
const MARKET_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

// Live, market-focused feeds (WSJ/Barron's RSS are defunct).
const MARKET_FEEDS = [
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', source: 'CNBC Markets' },
  { url: 'http://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC' },
];

const MARKET_BRIEF_SYSTEM = `You are a markets editor writing a concise daily brief for a busy investor.
From the provided stories, write 3-5 bullet points, each 2-3 sentences.
- Lead with what's moving markets today and why (indices, rates, big movers, macro).
- Be specific: cite numbers, companies, and drivers when present. Neutral tone, no hype.
- Group related stories; don't just restate headlines one by one.
Output ONLY Markdown bullets starting with "- ". No preamble, no headers.`;

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
  blocks.forEach(block => {
    const title = cleanRss((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = cleanRss((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    const description = cleanRss((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]);
    const pubDate = cleanRss((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (title) items.push({ title, url: link || null, description, pubDate, source });
  });
  return items;
}

function fetchMarketStories(limit, tz) {
  const collected = [];
  const opts = { method: 'get', headers: { 'User-Agent': MARKET_UA }, muteHttpExceptions: true };
  MARKET_FEEDS.forEach(feed => {
    try {
      const resp = UrlFetchApp.fetch(feed.url, opts);
      if (resp.getResponseCode() === 200) {
        collected.push.apply(collected, parseRss(resp.getContentText(), feed.source));
      }
    } catch (e) { /* try the next feed */ }
  });
  if (!collected.length) return [];

  const ms = (it) => { const d = new Date(it.pubDate); return isNaN(d.getTime()) ? 0 : d.getTime(); };
  collected.sort((a, b) => ms(b) - ms(a)); // newest first

  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const todays = collected.filter(it => {
    if (!it.pubDate) return false;
    const d = new Date(it.pubDate);
    if (isNaN(d.getTime())) return false;
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd') === today;
  });
  return (todays.length ? todays : collected).slice(0, limit);
}

// Returns { brief, sources } — brief is Markdown bullets; sources are the
// stories it drew on. Null if nothing loaded (section degrades gracefully).
function getMarketBrief(tz) {
  const stories = fetchMarketStories(12, tz);
  if (!stories.length) return null;
  const list = stories
    .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''} [${s.source}]`)
    .join('\n');
  const text = callGemini(
    MARKET_BRIEF_SYSTEM,
    `Today's market & finance stories:\n\n${list}\n\nWrite the brief.`,
    { temperature: 0.3, maxTokens: 700 }
  );
  if (!text || !text.trim()) return null;
  return { brief: text.trim(), sources: stories.slice(0, 5) };
}

// Render the brief to HTML matching the app's MarketsCard (bullets + SOURCES).
function renderMarketBriefHtml(mb) {
  if (!mb) {
    return `<h2>&#128240; Market Brief</h2><p class='subtext'>Market brief unavailable today.</p>`;
  }
  const bullets = mb.brief
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.indexOf('- ') === 0 || l.indexOf('* ') === 0)
    .map(l => {
      let t = l.replace(/^[-*]\s+/, '');
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); // **bold** -> <strong>
      return `<li style="margin-bottom: 8px;">${t}</li>`;
    })
    .join('');

  const sourceRows = (mb.sources || [])
    .map(s => {
      const inner = s.url
        ? `<a href="${s.url}" style="color:#666; text-decoration:none;">&middot; ${s.title}</a> (${s.source})`
        : `&middot; ${s.title} (${s.source})`;
      return `<div style="font-size: 12px; color: #666; line-height: 1.6;">${inner}</div>`;
    })
    .join('');

  const sourcesBlock = sourceRows
    ? `<div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid #eaeaea;">
         <div style="font-size: 10px; letter-spacing: 0.5px; color: #888; text-transform: uppercase; margin-bottom: 6px;">Sources</div>
         ${sourceRows}
       </div>`
    : '';

  return `<h2>&#128240; Market Brief</h2><ul style="padding-left: 20px;">${bullets}</ul>${sourcesBlock}`;
}

function sendMorningBriefing() {
  const date = new Date();
  const tz = Session.getScriptTimeZone();
  const dateString = Utilities.formatDate(date, tz, "EEEE, MMMM d, yyyy");
  const subject = "☀️ Morning Briefing — " + Utilities.formatDate(date, tz, "MMMM d, yyyy");

  // 1. Fetch Today's Calendar Events
  const calendar = CalendarApp.getDefaultCalendar();
  const events = calendar.getEventsForDay(date);
  let calendarData = "";
  if (events.length === 0) {
    calendarData += "<p class='cal-empty'>No events on your calendar today. A clear day &mdash; make it count. &#128511;</p>";
  } else {
    calendarData += "<ul style='padding-left: 20px;'>";
    events.forEach(event => {
      const startTime = Utilities.formatDate(event.getStartTime(), tz, "h:mm a");
      calendarData += `<li style='margin-bottom: 4px;'><b>${startTime}</b> - ${event.getTitle()}</li>`;
    });
    calendarData += "</ul>";
  }

  // 2. Fetch Unread Inbox Emails (15000 characters for deep analytical summaries)
  const threads = GmailApp.search('is:unread in:inbox', 0, 15);
  let emailData = "Unread Emails:\n";
  threads.forEach(thread => {
    const msg = thread.getMessages()[0];
    emailData += `From: ${msg.getFrom()} | Subject: ${msg.getSubject()}\nSnippet: ${msg.getPlainBody().substring(0, 15000)}...\n\n`;
  });

  // 3. Fetch Universal Principles (Randomized via Apps Script)
  let selectedPrinciple = "";
  try {
    const doc = DocumentApp.openById(DOC_ID);
    const fullText = doc.getBody().getText();
    const principlesArray = fullText.split('\n').filter(p => p.trim().length > 30);
    if (principlesArray.length > 0) {
      const randomIndex = Math.floor(Math.random() * principlesArray.length);
      selectedPrinciple = principlesArray[randomIndex].trim();
    } else {
      selectedPrinciple = "Seek wisdom in all things.";
    }
  } catch (e) {
    selectedPrinciple = "Error: Could not fetch document. Please ensure the DOC_ID points to a native Google Doc.";
  }

  // Fetch Notion Wisdom (deep crawl: every sub-page, full nested text)
  const notionData = getRandomNotionWisdom(NOTION_PAGE_ID, NOTION_API_KEY);

  // Build the Market Brief (live RSS feeds — exactly what the app's card shows).
  const marketBriefHtml = renderMarketBriefHtml(getMarketBrief(tz));

  // 4. Determine Workout Day
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const currentDay = days[date.getDay()];
  const workoutPlan = `Mon=Zone 2 Walk 45min HR 135-145, Tue=Recovery+Mobility, Wed=Japanese Intervals 45-55min, Thu=Strength Push, Fri=Full Recovery, Sat=Zone 2 Walk, Sun=Strength Pull.
  HRV rules: Green=train, Yellow=downgrade, Red=mobility/walk.
  Protein: strength=100-115g, recovery=70-85g.`;

  // 5. CSS Template Shell (Exact match to the premium PDF format)
  const htmlHead = `
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; }
      h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px; color: #333; margin-top: 35px; margin-bottom: 12px; }
      p { margin-bottom: 16px; }
      .quote-box { background: #fdfdfd; border-left: 3px solid #ccc; padding: 10px 16px; margin-bottom: 16px; font-style: italic; color: #444; font-size: 14.5px; }
      .workout-box { border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; background-color: #fafafa; }
      .workout-label { font-weight: 600; margin-bottom: 8px; font-size: 15px; }
      .newsletter-title { font-weight: 700; font-size: 15.5px; margin-bottom: 4px; color: #000; }
      .subtext { font-size: 13.5px; color: #666; }
      .cal-empty { font-size: 14px; color: #555; }
      hr { border: 0; border-top: 1px solid #eaeaea; margin: 25px 0; }
    </style>
    </head>
    <body>
  `;

  // 6. Build the Prompt for Gemini
  const prompt = `You are NormOS — Norm's chief of staff, executive coach, and a sharp financial analyst. Generate ONLY the HTML body content for an email. DO NOT wrap your output in \`\`\`html blocks. Your voice is sharp, caring, blunt, and numerate — no flattery, no filler. NEVER invent a number, a company, or a fact that is not in the source material.

  CRITICAL: You MUST use HTML Entity Codes for emojis (e.g. &#128161; &#128214; &#128240; &#128680; &#128197; &#128170;). DO NOT output raw unicode emojis.

  Structure the output EXACTLY like this:

  <p>Good morning, Norm!</p>
  <p>Remember to show up with joy, presence, and courage today :)</p>
  <p class="subtext">${dateString}</p>
  <hr>

  <h2>&#128161; QUOTE + INSIGHT</h2>
  <div class="quote-box">"${selectedPrinciple}"</div>
  <p><b>The key idea:</b> [Write EXACTLY 2 sentences. The FIRST draws out the deeper principle or idea in the quote as lived wisdom. The SECOND makes it land for where Norm is RIGHT NOW — speak to the human, not the day. You may anchor it to his life as a husband and future father, but do NOT reference his job, calendar, tasks, schedule, "today", or his finances. Punchy and reflective.]</p>
  <hr>

  <h2>&#128214; NOTION WISDOM</h2>
  <div class="quote-box">"[Select the SINGLE most resonant COMPLETE sentence or passage from the Notion text below and quote it VERBATIM. Never pick a title, a heading, or an intro fragment that trails off (e.g. one ending in a colon). If the best idea spans a full sentence, quote the WHOLE sentence — never cut off mid-thought. Notion text: ${notionData.substring(0, 3000)}]"</div>
  <p><b>The key idea:</b> [Write EXACTLY 2 sentences drawing out the key idea in the SPECIFIC passage you just quoted — the commentary MUST match that exact passage. First sentence: the core idea as lived wisdom. Second sentence: how to practically apply it, speaking to the human not the day.]</p>
  <hr>

  <h2>&#128240; NEWSLETTERS</h2>
  [For EACH newsletter, digest, or editorial publication in the email data below, output ONE block in the format shown. INCLUDE digests and publications (e.g. The Daily Upside, Morning Brew, Stratechery, Substacks). EXCLUDE personal emails, receipts, order/shipping confirmations, calendar invites, and automated notifications. Never combine two newsletters into one block. If there are no newsletters, output only: <p class='subtext'>No newsletters in your inbox today.</p>  Email data: ${emailData}]
  <div style="margin-bottom: 24px;">
    <div class="newsletter-title">[Sender Name] &mdash; "[Edition / Article Title]"</div>
    <p>[A dense, 5-10 sentence paragraph summarizing the substance of THIS specific email. Extract every hard number, percentage, dollar amount, named company, person, and specific argument. Emulate the deep, factual style of premium financial newsletters like The Daily Upside. Crisp prose, no bullets, no filler.]</p>
  </div>
  <hr>

  <h2>&#128680; URGENT INBOX</h2>
  [List any actionable/time-sensitive non-newsletter emails where a real person expects a response or there is a deadline/decision needing Norm's input. Be concise. Exclude newsletters, digests, marketing, receipts, and notifications. If none, output: "<p class='subtext'>Inbox clear. No urgent actions required.</p>"]
  <hr>

  [OUTPUT THE FOLLOWING MARKET BRIEF SECTION EXACTLY AS GIVEN, VERBATIM — do not rewrite, summarize, reorder, or alter any of its text or HTML:]
  ${marketBriefHtml}
  <hr>

  <h2>&#128197; CALENDAR &mdash; Today</h2>
  ${calendarData}
  <hr>

  <h2>&#128170; WORKOUT</h2>
  <div class="workout-box">
    <div class="workout-label">Today: ${currentDay} &rarr; [Insert exact workout based on this logic: ${workoutPlan}]</div>
    <p class="subtext" style="margin-bottom: 4px;"><b>Protein Target:</b> [Insert target based on day]</p>
    <p class="subtext" style="margin-bottom: 0;"><i>Check your HRV before deciding. If you're feeling off, default to recovery.</i></p>
  </div>
  `;

  // 7. Call Gemini for the narrative body
  let htmlBody = callGemini(
    "You are NormOS, a sharp and numerate chief of staff. Output raw HTML only. Never output raw emojis — use HTML entity codes exclusively. Never invent numbers, companies, or facts not present in the source material.",
    prompt,
    { temperature: 0.2, maxTokens: 8192 }
  );
  if (!htmlBody) { Logger.log("No body returned from Gemini; aborting."); return; }
  htmlBody = htmlBody.replace(/```html/g, '').replace(/```/g, '');

  const finalHtml = htmlHead + htmlBody + "</body></html>";

  // 8. Send the Email using GmailApp
  GmailApp.sendEmail(TARGET_EMAIL, subject, "", { htmlBody: finalHtml });
  Logger.log("Email sent successfully!");
}
