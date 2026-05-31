// Read/write helpers for the knowledge corpus (documents + embeddings).
const { query } = require('../db');

function toVectorLiteral(embedding) {
  if (!embedding || !Array.isArray(embedding)) return null;
  return `[${embedding.join(',')}]`;
}

/**
 * Upsert a document, deduped on (source, external_id). Embedding is optional —
 * it can be backfilled later by the intelligence layer.
 */
async function upsertDocument(doc) {
  const {
    source,
    domain,
    externalId = null,
    title = null,
    author = null,
    url = null,
    content,
    occurredAt = null,
    metadata = {},
    embedding = null,
  } = doc;

  if (!content) return null;

  const { rows } = await query(
    `INSERT INTO documents
       (source, domain, external_id, title, author, url, content, occurred_at, metadata, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
     ON CONFLICT (source, external_id) DO UPDATE
       SET title = EXCLUDED.title,
           author = EXCLUDED.author,
           url = EXCLUDED.url,
           content = EXCLUDED.content,
           occurred_at = EXCLUDED.occurred_at,
           metadata = EXCLUDED.metadata,
           embedding = COALESCE(EXCLUDED.embedding, documents.embedding)
     RETURNING id`,
    [
      source,
      domain,
      externalId,
      title,
      author,
      url,
      content,
      occurredAt,
      metadata,
      toVectorLiteral(embedding),
    ]
  );
  return rows[0]?.id ?? null;
}

/** Semantic search by cosine distance. Requires embeddings to be populated. */
async function searchSimilar(embedding, { k = 8, domain = null } = {}) {
  const vec = toVectorLiteral(embedding);
  if (!vec) return [];
  const { rows } = await query(
    `SELECT id, source, domain, title, author, url, content, occurred_at,
            1 - (embedding <=> $1::vector) AS similarity
       FROM documents
      WHERE embedding IS NOT NULL
        AND ($3::text IS NULL OR domain = $3)
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [vec, k, domain]
  );
  return rows;
}

// Keyword search over author/title — catches named entities (authors, book
// titles) that pure semantic search misses, since author isn't in the vector.
// Ranks by how many query terms hit. Used alongside searchSimilar in chat.
async function searchText(terms, { k = 8 } = {}) {
  const clean = (terms || []).filter((t) => t && t.length >= 3).slice(0, 8);
  if (!clean.length) return [];
  const conds = [];
  const score = [];
  const params = [];
  for (const t of clean) {
    params.push(`%${t}%`);
    const p = `$${params.length}`;
    conds.push(`(author ILIKE ${p} OR title ILIKE ${p})`);
    score.push(`(author ILIKE ${p} OR title ILIKE ${p})::int`);
  }
  params.push(k);
  const { rows } = await query(
    `SELECT id, source, domain, title, author, url, content, occurred_at,
            (${score.join(' + ')}) AS score
       FROM documents
      WHERE ${conds.join(' OR ')}
      ORDER BY score DESC, occurred_at DESC NULLS LAST
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** Documents still missing an embedding (for the embedding backfill job). */
async function listWithoutEmbedding(limit = 100) {
  const { rows } = await query(
    `SELECT id, title, author, content FROM documents
      WHERE embedding IS NULL
      ORDER BY ingested_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Attach an embedding to a document. */
async function setEmbedding(id, embedding) {
  await query(`UPDATE documents SET embedding = $2::vector WHERE id = $1`, [
    id,
    toVectorLiteral(embedding),
  ]);
}

async function countMissingEmbeddings() {
  const { rows } = await query(`SELECT count(*)::int AS n FROM documents WHERE embedding IS NULL`);
  return rows[0]?.n ?? 0;
}

/** Most recent documents, optionally scoped to a domain. */
async function recent({ domain = null, limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT id, source, domain, title, author, url, occurred_at, ingested_at
       FROM documents
      WHERE ($1::text IS NULL OR domain = $1)
      ORDER BY COALESCE(occurred_at, ingested_at) DESC
      LIMIT $2`,
    [domain, limit]
  );
  return rows;
}

/**
 * Random highlights for the daily Readwise card. Favorites-first, filling with
 * other random highlights if fewer favorites exist than `limit`. `exclude` is a
 * list of ids shown recently (last 30 days) — we skip those so the card cycles
 * through everything before repeating. Only falls back to excluded ids if we'd
 * otherwise come up short, so the card never renders empty.
 */
async function randomHighlights({ limit = 5, favoritesOnly = false, exclude = [] } = {}) {
  const ex = exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000'];

  // 1) Fresh favorites (not shown recently).
  const favFresh = await query(
    `SELECT id, title, author, url, content, occurred_at, metadata
       FROM documents
      WHERE source = 'readwise' AND (metadata->>'favorite') = 'true'
        AND NOT (id = ANY($2::uuid[]))
      ORDER BY random() LIMIT $1`,
    [limit, ex]
  );
  let picks = favFresh.rows;

  // 2) Fill with fresh non-favorites (unless strict).
  if (!favoritesOnly && picks.length < limit) {
    const taken = picks.map((r) => r.id).concat(ex);
    const rest = await query(
      `SELECT id, title, author, url, content, occurred_at, metadata
         FROM documents
        WHERE source = 'readwise'
          AND NOT (id = ANY($2::uuid[]))
        ORDER BY random() LIMIT $1`,
      [limit - picks.length, taken]
    );
    picks = picks.concat(rest.rows);
  }

  // 3) Last resort — if everything's been seen, reuse favorites/any so we never
  //    show an empty card (the 30-day window has fully cycled).
  if (picks.length < limit) {
    const taken = picks.map((r) => r.id);
    const fallback = await query(
      `SELECT id, title, author, url, content, occurred_at, metadata
         FROM documents
        WHERE source = 'readwise'
          AND NOT (id = ANY($3::uuid[]))
          AND ($2::boolean IS FALSE OR (metadata->>'favorite') = 'true')
        ORDER BY (metadata->>'favorite' = 'true') DESC, random()
        LIMIT $1`,
      [limit - picks.length, favoritesOnly, taken.length ? taken : ex]
    );
    picks = picks.concat(fallback.rows);
  }
  return picks;
}

/**
 * Monthly spend per category from Monarch transaction documents. Spend is the
 * sum of negative amounts (money out), returned positive. Grouped by calendar
 * month (YYYY-MM) for the trailing `months` window. Powers wealth insights.
 */
async function monthlyCategorySpend({ months = 4 } = {}) {
  const { rows } = await query(
    `SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS month,
            COALESCE(NULLIF(metadata->>'category', ''), 'Uncategorized')  AS category,
            SUM(CASE WHEN (metadata->>'amount')::numeric < 0
                     THEN -(metadata->>'amount')::numeric ELSE 0 END)     AS spend
       FROM documents
      WHERE source = 'monarch'
        AND occurred_at >= date_trunc('month', now()) - ($1::int - 1) * interval '1 month'
        AND metadata ? 'amount'
      GROUP BY 1, 2
      HAVING SUM(CASE WHEN (metadata->>'amount')::numeric < 0
                      THEN -(metadata->>'amount')::numeric ELSE 0 END) > 0
      ORDER BY 1 DESC, 3 DESC`,
    [months]
  );
  return rows.map((r) => ({ month: r.month, category: r.category, spend: Number(r.spend) }));
}

module.exports = {
  upsertDocument,
  searchSimilar,
  searchText,
  recent,
  randomHighlights,
  monthlyCategorySpend,
  listWithoutEmbedding,
  setEmbedding,
  countMissingEmbeddings,
};
