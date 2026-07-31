// Retry worker for raw user-context entries whose first compile attempt was
// unavailable. This worker never holds a DB transaction open during an LLM
// call; it claims the durable job, compiles, then atomically persists the
// result and completion marker.
const jobs = require('../store/contextCompilationJobs');
const contextAssertionsStore = require('../store/contextAssertions');
const { compileUserContext, persistCompiledContext } = require('./context-compiler');
const { withTransaction } = require('../db');

async function processOneContextCompilationJob({ now = new Date(), jobId = null } = {}) {
  const job = await jobs.claimNext({ now, jobId });
  if (!job) return { processed: false };

  let persisted = null;
  try {
    const recordedAt = new Date(job.recorded_at);
    const recentActiveAssertions = await contextAssertionsStore
      .getActive({ recordedFrom: new Date(recordedAt.getTime() - 7 * 24 * 60 * 60 * 1000) })
      .catch(() => []);
    const compiled = await compileUserContext({
      rawText: job.raw_text,
      source: job.source,
      question: job.question,
      tz: job.timezone,
      now: recordedAt,
      recentActiveAssertions,
    });

    if (compiled.failed) {
      const retry = await jobs.reschedule(job.id, { attempts: job.attempts, error: compiled.failureType });
      return { processed: true, succeeded: false, retry };
    }

    await withTransaction(async (client) => {
      const db = (text, params) => client.query(text, params);
      if (!await jobs.isSourceAnnotationActive(job.source_annotation_id, db)) {
        await jobs.cancelForSourceAnnotation(job.source_annotation_id, db);
        return;
      }
      persisted = await persistCompiledContext(compiled, { sourceAnnotationId: job.source_annotation_id, db });
      await jobs.markSucceeded(job.id, db);
    });
  } catch (err) {
    // A worker exception after a job was claimed used to strand it forever in
    // `processing`. Requeue from the pool connection only after its failed
    // transaction has rolled back, preserving the same bounded retry policy
    // as an explicit compiler failure.
    const retry = await jobs.reschedule(job.id, { attempts: job.attempts, error: err.message });
    console.error(`[context-compilation-outbox] job ${job.id} failed:`, err.message);
    return { processed: true, succeeded: false, retry };
  }

  if (persisted?.assertionIds?.length) {
    await require('../brain/invalidation').bumpDurable('context_assertion_change');
  }
  return {
    processed: true,
    succeeded: Boolean(persisted),
    assertionCount: persisted?.assertionIds?.length ?? 0,
    canceled: !persisted,
  };
}

async function drainContextCompilationJobs({ limit = 3 } = {}) {
  const results = [];
  for (let i = 0; i < limit; i++) {
    const result = await processOneContextCompilationJob();
    if (!result.processed) break;
    results.push(result);
  }
  return results;
}

module.exports = { processOneContextCompilationJob, drainContextCompilationJobs };
