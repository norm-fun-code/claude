// Backfills vector embeddings for documents that don't have one yet, so the
// knowledge graph (semantic search / RAG chat) works. Batches to limit cost.
require('dotenv').config();
const llm = require('../llm');
const documents = require('../store/documents');

const MAX_CHARS = 4000; // keep embedding inputs bounded

async function embedPending({ batch = 32, maxBatches = 20 } = {}) {
  let embedded = 0;
  for (let i = 0; i < maxBatches; i++) {
    const pending = await documents.listWithoutEmbedding(batch);
    if (pending.length === 0) break;

    const inputs = pending.map((d) =>
      [d.title, d.content].filter(Boolean).join('\n').slice(0, MAX_CHARS)
    );
    const vectors = await llm.embed(inputs);

    for (let j = 0; j < pending.length; j++) {
      if (vectors[j]) {
        await documents.setEmbedding(pending[j].id, vectors[j]);
        embedded++;
      }
    }
  }
  const remaining = await documents.countMissingEmbeddings();
  return { embedded, remaining };
}

module.exports = { embedPending };

// CLI entrypoint
if (require.main === module) {
  const { pool } = require('../db');
  embedPending()
    .then((s) => console.log(`Embedded ${s.embedded} documents (${s.remaining} remaining).`))
    .catch((err) => {
      console.error('Embedding failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
