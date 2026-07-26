// Today tab redesign — regression test #11 ("mobile renders older stored
// briefing payloads safely"). selectTodayCommandCenter is the ONE place
// that defines what an older cached BriefingData (written before
// todayCommandCenter existed) degrades to — every Today component reads
// through this instead of its own inline `d?.todayCommandCenter?.x ?? y`.
//
//   node --experimental-strip-types --test src/lib/todayCommandCenter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTodayCommandCenter } from './todayCommandCenter.ts';
import type { BriefingData } from '../hooks/useBriefing.ts';

test('selectTodayCommandCenter: null/undefined data never throws, degrades to the empty view', () => {
  assert.deepEqual(selectTodayCommandCenter(null), { risk: null, sinceMorning: [], previews: [] });
  assert.deepEqual(selectTodayCommandCenter(undefined), { risk: null, sinceMorning: [], previews: [] });
});

test('selectTodayCommandCenter: an OLDER stored payload with no todayCommandCenter key at all degrades safely', () => {
  // Exactly what a briefing payload hydrated from an AsyncStorage cache
  // written before this field existed looks like — every other field
  // present and normal, todayCommandCenter simply absent.
  const older = {
    date: '2026-01-01', chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    forecasts: [], weeklyReview: null, wealth: null,
  } as unknown as BriefingData;
  const view = selectTodayCommandCenter(older);
  assert.equal(view.risk, null);
  assert.deepEqual(view.sinceMorning, []);
  assert.deepEqual(view.previews, []);
});

test('selectTodayCommandCenter: a present-but-partial todayCommandCenter (missing sinceMorning/previews arrays) still degrades to empty arrays, not undefined', () => {
  const partial = {
    todayCommandCenter: {
      snapshotId: 'x', snapshotVersion: 3, snapshotAt: null, builtAt: null,
      now: { stableId: 'now:x', headline: 'h', detail: null },
      action: null, risk: null,
      // sinceMorning/previews deliberately omitted, as an even-older
      // partial rollout of this field might have shipped.
    },
  } as unknown as BriefingData;
  const view = selectTodayCommandCenter(partial);
  assert.deepEqual(view.sinceMorning, []);
  assert.deepEqual(view.previews, []);
});

test('selectTodayCommandCenter: a fresh, complete payload passes risk/sinceMorning/previews through verbatim', () => {
  const fresh = {
    todayCommandCenter: {
      snapshotId: 'x', snapshotVersion: 3, snapshotAt: 'now', builtAt: 'now',
      now: { stableId: 'now:x', headline: 'h', detail: null },
      action: { stableId: 'action:x', title: 'do it', rationale: null },
      risk: { stableId: 'risk:x', title: 'r', rationale: 'rr', severity: 'watch' },
      sinceMorning: [{ stableId: 's1', occurredAt: null, summary: 'x', destination: 'wealth' }],
      previews: [{ domain: 'health', title: 't', summary: 's', destination: 'health' }],
    },
  } as unknown as BriefingData;
  const view = selectTodayCommandCenter(fresh);
  assert.equal(view.risk?.stableId, 'risk:x');
  assert.equal(view.sinceMorning.length, 1);
  assert.equal(view.previews.length, 1);
});
