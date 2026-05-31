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

module.exports = {
  upsertDocument,
  searchSimilar,
  searchText,
  recent,
  listWithoutEmbedding,
  setEmbedding,
  countMissingEmbeddings,
};
