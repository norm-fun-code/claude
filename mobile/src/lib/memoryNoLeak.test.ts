// Product audit rec #6, required: "no raw internal metadata leaks into the
// mobile UI". Source-level regression guard (same pattern as
// wealthNoDuplication.test.ts) — MemoryScreen.tsx/useMemory.ts must only
// ever reference the human-shaped MemoryItem fields the backend projection
// (backend/src/intelligence/memory-projection.js) already produces, never a
// raw snake_case column, policy enum, or table name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  join(process.cwd(), 'src/components/MemoryScreen.tsx'),
  join(process.cwd(), 'src/hooks/useMemory.ts'),
];

// Deliberately excludes 'context_assertions'/'context_relations' — those
// module/table names legitimately appear in explanatory doc comments (this
// screen's header comment says which backend stores it reads); the real
// leak vector is a raw FIELD name or enum value reaching rendered UI text or
// a request/response shape, which the tokens below cover.
const FORBIDDEN = [
  'source_authority', 'assertion_type', 'event_status', 'compiler_version',
  'dedup_key', 'user_locked', 'evidence_basis', 'supersedes_assertion_id',
  'retired_at', 'effective_start', 'effective_end',
  'sourceAuthority', 'assertionType', 'eventStatus',
];

test('required: MemoryScreen/useMemory never reference raw internal column names or policy enums', () => {
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN) {
      assert.ok(!src.includes(token), `${file} must not reference the raw internal token "${token}"`);
    }
  }
});

test('required: MemoryScreen never renders JSON.stringify of a whole memory item (no raw-JSON dump)', () => {
  const src = readFileSync(join(process.cwd(), 'src/components/MemoryScreen.tsx'), 'utf8');
  assert.doesNotMatch(src, /JSON\.stringify\(\s*item\b/, 'the screen must present human fields, never a raw JSON dump of an item');
});
