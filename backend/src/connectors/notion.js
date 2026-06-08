// Notion connector (Learning domain). Ingests your Notion "wisdom" pages as
// knowledge documents so they're searchable and connectable alongside Readwise
// highlights. Incremental: only re-fetches pages edited since the last sync.
const { listWisdomPages, fetchPageText } = require('../services/notion');

module.exports = {
  id: 'notion',
  domain: 'learning',
  displayName: 'Notion Wisdom',

  async sync(ctx = {}) {
    if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY not set');

    const since = ctx.lastSyncAt ? new Date(ctx.lastSyncAt).getTime() : 0;
    const pages = await listWisdomPages();

    const documents = [];
    for (const page of pages) {
      // Skip unchanged pages on incremental runs.
      const edited = page.lastEdited ? new Date(page.lastEdited).getTime() : Infinity;
      if (since && edited <= since) continue;

      const text = await fetchPageText(page.id);
      if (!text || !text.trim()) continue;

      documents.push({
        source: 'notion',
        domain: 'learning',
        externalId: page.id,
        title: page.title,
        url: `https://www.notion.so/${page.id.replace(/-/g, '')}`,
        content: text,
        occurredAt: page.lastEdited,
        metadata: { pageId: page.id },
      });
    }

    return { metrics: [], documents };
  },
};
