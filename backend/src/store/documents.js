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
async function upsertDocument(doc, db = query) {
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

  const { rows } = await db(
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
 * Monthly spend per category from Monarch transaction documents. Spend is
 * the NET of every transaction in the category (a positive refund/credit in
 * the same expense category nets its total down — Monarch's own Reports
 * convention, and the SAME refund-netting connectors/monarch.js's
 * reconcileWealthFlows applies to the canonical wealth:spending_discretionary
 * metric), returned positive when the category is a genuine net spend.
 * Grouped by calendar month (YYYY-MM) for the trailing `months` window.
 * Powers wealth insights.
 *
 * Wealth matched-pace hardening pass: no read-time DISTINCT-ON dedup here —
 * storage already guarantees uniqueness per (source, external_id) via
 * upsertDocument's ON CONFLICT, and cross-importer overlap for the same
 * real-world transaction is reconciled at WRITE time (monarch-mcp-sync.js's
 * `reconcile`/pruneDocuments), never by collapsing rows that merely SHARE a
 * date/merchant/amount/account — two genuinely separate same-day purchases
 * of the same amount at the same merchant must both count.
 */
async function monthlyCategorySpend({ months = 4 } = {}) {
  const { rows } = await query(
    `SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS month,
            COALESCE(NULLIF(metadata->>'category', ''), 'Uncategorized') AS category,
            -SUM((metadata->>'amount')::numeric) AS spend
       FROM documents
      WHERE source = 'monarch'
        AND occurred_at >= date_trunc('month', now()) - ($1::int - 1) * interval '1 month'
        AND occurred_at <= now()
        AND metadata ? 'amount'
      GROUP BY 1, 2
      HAVING -SUM((metadata->>'amount')::numeric) > 0
      ORDER BY 1 DESC, 3 DESC`,
    [months]
  );
  return rows.map((r) => ({ month: r.month, category: r.category, spend: Number(r.spend) }));
}

/**
 * Raw spend transactions (amount < 0) over the last `days`, for recurring-charge
 * / subscription detection. Returns [{ day, merchant, amount, category }] with
 * amount as a positive spend figure, newest first.
 */
async function spendTransactions({ days = 120 } = {}) {
  // Same read-time de-dup as monthlyCategorySpend — transient duplicate documents
  // (two importers) must not double-count toward recurring-charge detection.
  const { rows } = await query(
    `SELECT DISTINCT ON (
              occurred_at::date,
              lower(coalesce(metadata->>'merchant','')),
              metadata->>'amount',
              lower(coalesce(metadata->>'account',''))
            )
            occurred_at::date AS day,
            COALESCE(NULLIF(metadata->>'merchant',''), title, 'Transaction') AS merchant,
            -(metadata->>'amount')::numeric AS amount,
            COALESCE(NULLIF(metadata->>'category',''), 'Uncategorized') AS category
       FROM documents
      WHERE source = 'monarch'
        AND occurred_at >= now() - ($1::int || ' days')::interval
        AND metadata ? 'amount'
        AND (metadata->>'amount')::numeric < 0
      ORDER BY occurred_at::date,
               lower(coalesce(metadata->>'merchant','')),
               metadata->>'amount',
               lower(coalesce(metadata->>'account','')),
               occurred_at DESC`,
    [days]
  );
  return rows.map((r) => ({ day: r.day, merchant: r.merchant, amount: Number(r.amount), category: r.category }));
}

/**
 * Category spend for an ARBITRARY [fromYmd, toYmd] local-date range (both
 * inclusive) — monthlyCategorySpend only supports whole calendar months.
 * Powers the discretionary matched-pace baseline's per-category "driver"
 * breakdown, which needs a PARTIAL month (day 1 through the elapsed-fraction-
 * matched day) compared against the same partial window in prior months, not
 * a full month total.
 *
 * Wealth matched-pace hardening pass: spend is the NET of every transaction
 * in the category — a positive refund/credit in the same expense category
 * nets its total down (Monarch's own Reports convention; same semantics as
 * monthlyCategorySpend and connectors/monarch.js's reconcileWealthFlows). No
 * read-time DISTINCT-ON dedup: storage already guarantees uniqueness per
 * (source, external_id) via upsertDocument's ON CONFLICT, and cross-importer
 * overlap is reconciled at WRITE time (monarch-mcp-sync.js's
 * `reconcile`/pruneDocuments) — collapsing rows that merely share a
 * date/merchant/amount/account would wrongly drop two genuinely separate
 * same-day purchases of the same amount at the same merchant.
 */
async function categorySpendInRange({ fromYmd, toYmd }) {
  const { rows } = await query(
    `SELECT COALESCE(NULLIF(metadata->>'category', ''), 'Uncategorized') AS category,
            -SUM((metadata->>'amount')::numeric) AS spend
       FROM documents
      WHERE source = 'monarch'
        AND occurred_at::date >= $1::date
        AND occurred_at::date <= $2::date
        AND metadata ? 'amount'
      GROUP BY 1
      HAVING -SUM((metadata->>'amount')::numeric) > 0
      ORDER BY 2 DESC`,
    [fromYmd, toYmd]
  );
  return rows.map((r) => ({ category: r.category, spend: Number(r.spend) }));
}

/**
 * Raw per-transaction (day, category, amount) rows across a single bounding
 * [fromYmd, toYmd] window — the ONE query wealth-pace.js's matched-pace
 * baseline uses to resolve its ~14 current/historical windows in one round
 * trip instead of one query per window. Callers fetch the UNION of every
 * window they need in a single call (spanning the earliest fromYmd to the
 * latest toYmd across all windows) and then slice/classify/aggregate the
 * returned rows in memory per window — see
 * services/discretionarySpend.js's batchDiscretionaryBreakdown.
 */
async function rawSpendRowsInRange({ fromYmd, toYmd }) {
  const { rows } = await query(
    `SELECT occurred_at::date::text AS day,
            COALESCE(NULLIF(metadata->>'category', ''), 'Uncategorized') AS category,
            (metadata->>'amount')::numeric AS amount
       FROM documents
      WHERE source = 'monarch'
        AND occurred_at::date >= $1::date
        AND occurred_at::date <= $2::date
        AND metadata ? 'amount'`,
    [fromYmd, toYmd]
  );
  return rows.map((r) => ({ day: r.day, category: r.category, amount: Number(r.amount) }));
}

// Reconcile a re-synced window against the source's current truth: delete
// documents in [from, to] for this source/domain whose external_id is NOT in the
// freshly-fetched set. This is how a transaction moved to a different month (or
// deleted) gets removed from a period it no longer belongs to — the connector
// can only ADD/UPDATE via upsert, never know what disappeared, so the caller
// passes the ids it just saw and we prune the rest.
async function pruneDocuments({ source, domain = null, from, to, keepExternalIds = [] }) {
  if (!source || !from || !to) return 0;
  // Safety: an empty keep-set means the fetch returned nothing — don't delete a
  // whole window off a transient empty/failed read. Genuine "all deleted in
  // Monarch" is vanishingly rare and not worth that risk.
  if (!keepExternalIds.length) return 0;
  const { rowCount } = await query(
    `DELETE FROM documents
      WHERE source = $1
        AND ($2::text IS NULL OR domain = $2)
        AND occurred_at::date >= $3::date
        AND occurred_at::date <= $4::date
        AND NOT (external_id = ANY($5::text[]))`,
    [source, domain, from, to, keepExternalIds]
  );
  return rowCount;
}

module.exports = {
  upsertDocument,
  pruneDocuments,
  searchSimilar,
  searchText,
  recent,
  randomHighlights,
  monthlyCategorySpend,
  spendTransactions,
  categorySpendInRange,
  rawSpendRowsInRange,
  listWithoutEmbedding,
  setEmbedding,
  countMissingEmbeddings,
};
