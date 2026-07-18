// Live production bug: Wisdom used to be prewarmed automatically right
// after Chief, both from the post-build hook (routes/briefing.js) and from
// a boot-time backfill (server.js, since removed). Two independent trigger
// paths each internally sequencing "brief then wisdom" meant nothing
// actually stopped one chain's Wisdom call from overlapping another
// chain's Brief call — Railway logs showed simultaneous cache MISS for
// both kinds and two concurrent Interactions TTS calls, each timing out.
// Fix: Wisdom prewarming and the boot-time backfill are both removed
// entirely — Wisdom narration now only ever synthesizes on an explicit
// user Listen tap (routes/audio.js). This proves that against the REAL
// build path (buildFreshBriefing(), the same function the GET /briefing
// route and the scheduler both call), not just by reading the diff.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const voiceService = require('../../src/services/voice');

const priorToken = process.env.NORMOS_API_TOKEN;
delete process.env.NORMOS_API_TOKEN; // buildFreshBriefing is called directly, not over HTTP

const ORIGINAL_SYNTHESIZE = voiceService.synthesize;

afterEach(async () => {
  voiceService.synthesize = ORIGINAL_SYNTHESIZE;
  await db.query(`DELETE FROM tts_audio WHERE cache_key LIKE 'brief:%' OR cache_key LIKE 'wisdom:%'`);
});
after(async () => {
  if (priorToken !== undefined) process.env.NORMOS_API_TOKEN = priorToken;
  await closeDb();
});

test('a normal briefing build prewarms Chief only — Wisdom is never synthesized as a side effect of building or persisting a brief', async () => {
  // buildFreshBriefing() persists a real 'daily' briefings row as a
  // fire-and-forget side effect (routes/briefing.js) — snapshot existing
  // ids first so this test can delete exactly the row(s) IT created and
  // nothing else, rather than leaving stray unmarked rows for later tests
  // to trip over (the same shared-DB pollution class as
  // briefing-build-direct-call.test.js, which this test necessarily mirrors
  // since it drives the identical build path).
  const { rows: before } = await db.query(`SELECT id FROM briefings WHERE kind = 'daily'`);
  const beforeIds = new Set(before.map((r) => r.id));

  const kinds = [];
  voiceService.synthesize = async (script) => {
    kinds.push(script.includes("Here's today's wisdom") ? 'wisdom' : 'brief');
    return { audio: Buffer.from('stub-wav'), mime: 'audio/wav', model: 'stub-model' };
  };

  try {
    const { buildFreshBriefing } = require('../../src/routes/briefing');
    await buildFreshBriefing({ force: true });

    // Chief's prewarm is fire-and-forget from buildFreshBriefing's own
    // perspective (routes/briefing.js never awaits it) — give its promise
    // chain a moment to actually run and reach synthesize().
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(!kinds.includes('wisdom'), `Wisdom must never be synthesized automatically during a build — got synthesize() calls for: ${JSON.stringify(kinds)}`);
  } finally {
    const { rows: after } = await db.query(`SELECT id FROM briefings WHERE kind = 'daily'`);
    const newIds = after.map((r) => r.id).filter((id) => !beforeIds.has(id));
    if (newIds.length) await db.query(`DELETE FROM briefings WHERE id = ANY($1)`, [newIds]);
  }
});
