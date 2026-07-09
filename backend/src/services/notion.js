const { Client } = require('@notionhq/client');

// Cap pagination so a large/looping workspace can't spin forever (each page is
// 100 items, so 30 = up to 3,000 pages/blocks — plenty for a personal space).
const MAX_PAGE_ITERATIONS = 30;

function getNotionClient() {
  return new Client({ auth: process.env.NOTION_API_KEY });
}

function extractTextFromBlocks(blocks) {
  const lines = [];

  for (const block of blocks) {
    const type = block.type;
    const content = block[type];

    if (!content) continue;

    // Heading blocks are section labels, not quotable wisdom — mark them so the
    // LLM doesn't pick them as the notionQuote.
    if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') {
      const text = content.rich_text?.map((rt) => rt.plain_text).join('') || '';
      if (text.trim()) lines.push(`[section: ${text.trim()}]`);
      continue;
    }

    // Blocks that have rich_text arrays
    if (content.rich_text) {
      const text = content.rich_text.map((rt) => rt.plain_text).join('');
      if (text.trim()) lines.push(text.trim());
    }

    // Bulleted / numbered list items
    if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
      const text = content.rich_text?.map((rt) => rt.plain_text).join('') || '';
      if (text.trim()) lines.push(`• ${text.trim()}`);
    }
  }

  return lines.join('\n');
}

async function fetchRandomNotionPage({ exclude = [] } = {}) {
  const notion = getNotionClient();
  const pageId = process.env.NOTION_PAGE_ID;

  // List children of the parent page
  const childrenRes = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });

  // Filter only child_page blocks
  const childPages = childrenRes.results.filter((block) => block.type === 'child_page');

  // Empty text (not a fabricated sentence) — matches the shape briefing.js
  // already falls back to on a genuine fetch failure (unwrap() ?? { text: '',
  // pageTitle: 'Notion' }), so callers treat "no pages" and "fetch failed" the
  // same way instead of feeding the literal string "No pages found." to the
  // LLM as if it were real wisdom-page content to quote from.
  if (childPages.length === 0) {
    return { text: '', pageTitle: 'Notion' };
  }

  // Prefer pages not shown in the last 30 days (by title); fall back to all if
  // every page has been seen, so the card never comes up empty.
  const ex = new Set(exclude);
  const unseen = childPages.filter((p) => !ex.has(p.child_page?.title || 'Untitled'));
  const pool = unseen.length ? unseen : childPages;

  // Pick a random page from the freshest pool
  const randomPage = pool[Math.floor(Math.random() * pool.length)];
  const pageTitle = randomPage.child_page?.title || 'Untitled';

  // Fetch the blocks of the chosen child page
  const blocksRes = await notion.blocks.children.list({
    block_id: randomPage.id,
    page_size: 100,
  });

  const text = extractTextFromBlocks(blocksRes.results);

  return {
    text: text.slice(0, 3000), // Limit to keep Gemini prompt reasonable
    pageTitle,
  };
}

// Pull a readable title off any page object (works for pages under a page and
// database rows, where the title property can be named anything).
function getTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key]?.type === 'title') {
      const t = (props[key].title || []).map((x) => x.plain_text).join('').trim();
      if (t) return t;
    }
  }
  return 'Untitled';
}

// Enumerate EVERY page the integration can see (the whole shared subtree, at any
// nesting depth) via the search API — far cheaper and deeper than walking
// child_page blocks one level at a time. Share only your wisdom parent with the
// integration to scope this to your wisdom tree.
async function listWisdomPages() {
  const notion = getNotionClient();
  const pages = [];
  let cursor;
  let iters = 0;
  do {
    const res = await notion.search({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
      start_cursor: cursor,
    });
    for (const p of res.results) {
      pages.push({
        id: p.id,
        title: getTitle(p),
        lastEdited: p.last_edited_time || null,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && ++iters < MAX_PAGE_ITERATIONS);
  return pages;
}

// Fetch and flatten the full text of a page, recursing into nested blocks
// (toggles, columns, sub-lists) but NOT into sub-pages/databases — those are
// captured as their own documents by listWisdomPages().
async function fetchPageText(blockId, depth = 0) {
  if (depth > 6) return '';
  const notion = getNotionClient();
  const lines = [];
  let cursor;
  let iters = 0;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const block of res.results) {
      const type = block.type;
      const content = block[type];
      if (content?.rich_text) {
        const text = content.rich_text.map((rt) => rt.plain_text).join('').trim();
        if (text) {
          lines.push((type === 'bulleted_list_item' || type === 'numbered_list_item') ? `• ${text}` : text);
        }
      }
      if (block.has_children && type !== 'child_page' && type !== 'child_database') {
        const sub = await fetchPageText(block.id, depth + 1);
        if (sub) lines.push(sub);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && ++iters < MAX_PAGE_ITERATIONS);

  return lines.join('\n');
}

// Pull every quote (each bullet/line) from a dedicated Notion "Quotes" page.
// Used for the Today-tab quote of the day.
async function fetchNotionQuotes(pageId = process.env.NOTION_QUOTES_PAGE_ID) {
  if (!pageId) return [];
  const notion = getNotionClient();
  const quotes = [];
  let cursor;
  let iters = 0;
  do {
    const res = await notion.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor });
    for (const block of res.results) {
      const type = block.type;
      const content = block[type];
      if (content?.rich_text) {
        const text = content.rich_text.map((rt) => rt.plain_text).join('').trim();
        if (text) quotes.push(text);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && ++iters < MAX_PAGE_ITERATIONS);
  return quotes;
}

module.exports = {
  fetchRandomNotionPage,
  listWisdomPages,
  fetchPageText,
  fetchNotionQuotes,
  extractTextFromBlocks,
};
