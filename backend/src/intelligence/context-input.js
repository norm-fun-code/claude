// The ONE shared entrypoint every production path that durably records a
// user statement intended to become personal context must call (harden
// pass, item 1) — compiles the statement into ContextAssertions/
// ContextRelations and persists them atomically alongside the caller's own
// write, with strictly-after-commit invalidation. Exists so a caller never
// has to hand-roll the compile-outside-tx / persist-inside-tx /
// bumpDurable-after-commit discipline itself (see context-compiler.js's
// persistCompiledContext doc comment for why that ordering matters).
//
// routes/annotations.js's POST /briefing/context already implements this
// exact same discipline inline (it has several OTHER transactional writes —
// signal answers, open-question retirement — that need to share its one
// transaction, so it isn't a drop-in caller of this function). This module
// is for callers with a single simple write: chat/executeAction.js's
// add_context and log_day_context handlers, which is also what realtime
// voice sessions call through (chat/realtimeTools.js's executeNormosAction
// and deepAsk both delegate to executeAction()) — routing executeAction.js
// through this ONE call fixes both surfaces at once and can never
// double-compile, since they share the same function call.
const { compileUserContext, persistCompiledContext } = require('./context-compiler');

/**
 * @param {object} opts
 * @param {string} opts.rawText - the user's statement, already known to be
 *   intended as personal context (not an ordinary question or an assistant
 *   response — callers decide that before calling this).
 * @param {string} opts.source - short provenance tag (e.g. 'voice', 'ask',
 *   'briefing_context') carried onto the compiled assertions.
 * @param {string|null} [opts.question] - the question this answers, if any.
 * @param {string} [opts.tz]
 * @param {Date} [opts.now]
 * @param {(client, db: (text, params) => Promise) => Promise<T>} opts.writeInTransaction
 *   the caller's own DB write(s) (e.g. annotationsStore.createAnnotation,
 *   dayJournalStore.create), run in the SAME transaction compiled context is
 *   persisted through.
 * @param {(written: T) => (string|null)} [opts.getSourceAnnotationId]
 *   extracts a REAL `annotations` table row id from `writeInTransaction`'s
 *   result, if any — context_assertions.source_annotation_id is a uuid FK
 *   into `annotations` specifically, so this must be omitted (or return
 *   null) for a caller whose write targets a different table (e.g.
 *   dayJournalStore.create's row id is not an annotations id and must
 *   never be passed here). Defaults to always-null, the safe choice.
 * @returns {Promise<T>} whatever writeInTransaction returned.
 */
async function recordUserContext({ rawText, source, question = null, tz = process.env.TZ || 'America/New_York', now = new Date(), writeInTransaction, getSourceAnnotationId = () => null }) {
  const text = String(rawText || '').trim();
  const contextAssertionsStore = require('../store/contextAssertions');
  const { withTransaction } = require('../db');

  // Compile BEFORE opening the transaction — the LLM call must never hold a
  // DB transaction open (see context-compiler.js). A compiler failure
  // (refusal/timeout/malformed response) degrades to zero assertions —
  // compileUserContext never throws — so it can never block the caller's
  // underlying write.
  const compiled = text
    ? await compileUserContext({
        rawText: text, source, question, tz, now,
        recentActiveAssertions: await contextAssertionsStore.getActive({ recordedFrom: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }).catch(() => []),
      })
    : { failed: false, failureType: null, assertions: [], relations: [] };
  if (compiled.failed) {
    console.error(`[context-input] context compilation failed (${compiled.failureType}) for source=${source} — caller's write still proceeds, no structured assertions this time.`);
  }

  const result = await withTransaction(async (client) => {
    const db = (queryText, params) => client.query(queryText, params);
    const written = await writeInTransaction(client, db);
    if (compiled.assertions.length) {
      await persistCompiledContext(compiled, { sourceAnnotationId: getSourceAnnotationId(written) ?? null, db });
    }
    return written;
  });

  // Invalidation strictly AFTER commit, and only because we got here at all
  // — a rejected transaction throws out of the `await` above, so this line
  // is unreached on rollback (same discipline as routes/annotations.js's
  // POST /briefing/context — see persistCompiledContext's doc comment).
  if (compiled.assertions.length) {
    await require('../brain/invalidation').bumpDurable('context_assertion_change');
  }
  return result;
}

module.exports = { recordUserContext };
