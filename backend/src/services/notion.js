const { Client } = require('@notionhq/client');

function getNotionClient() {
  return new Client({ auth: process.env.NOTION_API_KEY });
}

function extractTextFromBlocks(blocks) {
  const lines = [];

  for (const block of blocks) {
    const type = block.type;
    const content = block[type];

    if (!content) continue;

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

async function fetchRandomNotionPage() {
  const notion = getNotionClient();
  const pageId = process.env.NOTION_PAGE_ID;

  // List children of the parent page
  const childrenRes = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });

  // Filter only child_page blocks
  const childPages = childrenRes.results.filter((block) => block.type === 'child_page');

  if (childPages.length === 0) {
    return { text: 'No pages found.', pageTitle: 'Notion' };
  }

  // Pick a random child page
  const randomPage = childPages[Math.floor(Math.random() * childPages.length)];
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

// List every child page under the wisdom parent (paginated), cheaply —
// returns descriptors only, so the caller can fetch text for changed pages.
async function listWisdomPages() {
  const notion = getNotionClient();
  const pageId = process.env.NOTION_WISDOM_PAGE_ID || process.env.NOTION_PAGE_ID;

  const pages = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const block of res.results) {
      if (block.type === 'child_page') {
        pages.push({
          id: block.id,
          title: block.child_page?.title || 'Untitled',
          lastEdited: block.last_edited_time || null,
        });
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return pages;
}

// Fetch and flatten the full text of a single page (paginated blocks).
async function fetchPageText(blockId) {
  const notion = getNotionClient();
  const blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return extractTextFromBlocks(blocks);
}

module.exports = {
  fetchRandomNotionPage,
  listWisdomPages,
  fetchPageText,
  extractTextFromBlocks,
};
