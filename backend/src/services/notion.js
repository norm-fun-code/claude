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

module.exports = { fetchRandomNotionPage };
