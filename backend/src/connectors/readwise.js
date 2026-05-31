// Readwise connector (Learning domain). Pulls books + highlights via the v2
// export API and stores each highlight as a knowledge document. Incremental:
// uses the source's last sync time as `updatedAfter` so re-runs are cheap.
//
// Readwise is the keystone learning integration — it already aggregates Kindle,
// articles, podcasts, and manual notes into one highlight stream.
const axios = require('axios');

const EXPORT_URL = 'https://readwise.io/api/v2/export/';

/** Pure mapper: Readwise export results -> { documents, bookCount, highlightCount }. */
function mapExport(results) {
  const documents = [];
  const books = new Set();

  for (const book of results || []) {
    if (book.user_book_id != null) books.add(book.user_book_id);
    for (const h of book.highlights || []) {
      const content = [h.text, h.note ? `Note: ${h.note}` : null]
        .filter(Boolean)
        .join('\n');
      if (!content) continue;
      documents.push({
        source: 'readwise',
        domain: 'learning',
        externalId: String(h.id),
        title: book.title || book.readable_title || null,
        author: book.author || null,
        url: h.url || book.source_url || book.unique_url || null,
        content,
        occurredAt: h.highlighted_at || h.created_at || null,
        metadata: {
          category: book.category,
          bookId: book.user_book_id,
          location: h.location,
          tags: (h.tags || []).map((t) => t.name || t),
          favorite: !!h.is_favorite, // hearted in Readwise — powers the daily highlights card
        },
      });
    }
  }

  return { documents, bookCount: books.size, highlightCount: documents.length };
}

module.exports = {
  id: 'readwise',
  domain: 'learning',
  displayName: 'Readwise',

  async sync(ctx = {}) {
    const token = process.env.READWISE_TOKEN;
    if (!token) throw new Error('READWISE_TOKEN not set');

    const headers = { Authorization: `Token ${token}` };
    const updatedAfter = ctx.lastSyncAt ? new Date(ctx.lastSyncAt).toISOString() : undefined;

    // Paginate the export endpoint to completion.
    const results = [];
    let pageCursor = null;
    do {
      const params = {};
      if (updatedAfter) params.updatedAfter = updatedAfter;
      if (pageCursor) params.pageCursor = pageCursor;
      const { data } = await axios.get(EXPORT_URL, { headers, params });
      results.push(...(data.results || []));
      pageCursor = data.nextPageCursor || null;
    } while (pageCursor);

    const { documents, bookCount, highlightCount } = mapExport(results);
    const now = new Date();
    const metrics = [
      { ts: now, domain: 'learning', metric: 'highlights_synced', value: highlightCount, unit: 'count', source: 'readwise' },
      { ts: now, domain: 'learning', metric: 'books_synced', value: bookCount, unit: 'count', source: 'readwise' },
    ];

    return { metrics, documents };
  },

  // exported for unit testing
  mapExport,
};
