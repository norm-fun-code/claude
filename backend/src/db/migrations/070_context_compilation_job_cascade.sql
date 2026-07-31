-- A compilation job is a disposable derivative of its raw annotation. Direct
-- annotation cleanup (including existing route/integration maintenance paths)
-- must never be blocked by a queued/succeeded job, and a deleted source must
-- never be compiled later. Migration 069 created the initial FK without its
-- required cascade; repair that forward for already-deployed databases.
ALTER TABLE context_compilation_jobs
  DROP CONSTRAINT IF EXISTS context_compilation_jobs_source_annotation_id_fkey;

ALTER TABLE context_compilation_jobs
  ADD CONSTRAINT context_compilation_jobs_source_annotation_id_fkey
  FOREIGN KEY (source_annotation_id) REFERENCES annotations(id) ON DELETE CASCADE;
