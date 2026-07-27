// Today tab redesign — regression test #11/#20 ("mobile renders older stored
// briefing payloads safely"). selectTodayCommandCenter is the ONE place
// that defines what an older cached BriefingData (written before
// todayCommandCenter — or one of its newer fields, like radar/planConflict —
// existed) degrades to; every Today component reads through this instead of
// its own inline `d?.todayCommandCenter?.x ?? y`.
//
//   node --experimental-strip-types --test src/lib/todayCommandCenter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTodayCommandCenter } from './todayCommandCenter.ts';
import type { BriefingData } from '../hooks/useBriefing.ts';

test('selectTodayCommandCenter: null/undefined data never throws, degrades to the empty view', () => {
  assert.deepEqual(selectTodayCommandCenter(null), { risk: null, sinceMorning: [], radar: [], planConflict: null });
  assert.deepEqual(selectTodayCommandCenter(undefined), { risk: null, sinceMorning: [], radar: [], planConflict: null });
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
  assert.deepEqual(view.radar, []);
  assert.equal(view.planConflict, null);
});

test('selectTodayCommandCenter: an EVEN-OLDER payload with the retired `previews` array (pre-radar redesign) degrades safely — radar/planConflict just are not present', () => {
  const preRadar = {
    todayCommandCenter: {
      snapshotId: 'x', snapshotVersion: 3, snapshotAt: 'now', builtAt: 'now',
      now: { stableId: 'now:x', headline: 'h', detail: null },
      action: null, risk: null, sinceMorning: [],
      // The OLD field name, from before radar.js existed — must NOT crash
      // or be misread as `radar`.
      previews: [{ domain: 'health', title: 't', summary: 's', destination: 'health' }],
    },
  } as unknown as BriefingData;
  const view = selectTodayCommandCenter(preRadar);
  assert.deepEqual(view.radar, []);
  assert.equal(view.planConflict, null);
});

test('selectTodayCommandCenter: a present-but-partial todayCommandCenter (missing sinceMorning/radar arrays) still degrades to empty arrays, not undefined', () => {
  const partial = {
    todayCommandCenter: {
      snapshotId: 'x', snapshotVersion: 3, snapshotAt: null, builtAt: null,
      now: { stableId: 'now:x', headline: 'h', detail: null },
      action: null, risk: null,
      // sinceMorning/radar deliberately omitted, as an even-older partial
      // rollout of this field might have shipped.
    },
  } as unknown as BriefingData;
  const view = selectTodayCommandCenter(partial);
  assert.deepEqual(view.sinceMorning, []);
  assert.deepEqual(view.radar, []);
  assert.equal(view.planConflict, null);
});

test('selectTodayCommandCenter: a fresh, complete payload passes risk/sinceMorning/radar/planConflict through verbatim', () => {
  const fresh = {
    todayCommandCenter: {
      snapshotId: 'x', snapshotVersion: 3, snapshotAt: 'now', builtAt: 'now',
      now: { stableId: 'now:x', headline: 'h', detail: null },
      action: { stableId: 'action:x', title: 'do it', rationale: null },
      planConflict: null,
      risk: { stableId: 'risk:x', title: 'r', rationale: 'rr', severity: 'watch' },
      sinceMorning: [{ stableId: 's1', occurredAt: null, summary: 'x', destination: 'wealth' }],
      radar: [{
        stableId: 'radar:x:wealth_insight', domain: 'wealth', entityId: 'e', snapshotId: 'x',
        priority: 1, status: 'open', attentionClass: 'action_required', headline: 'h', whyNow: 'w',
        evidenceSummary: null, evidenceItems: null, asOf: null, actionLabel: 'Open in Wealth',
        destination: { surface: 'wealth', entityType: 'wealthInsight', entityId: 'e', anchor: 'e', snapshotId: null, fallbackRoute: 'wealth' },
      }],
    },
  } as unknown as BriefingData;
  const view = selectTodayCommandCenter(fresh);
  assert.equal(view.risk?.stableId, 'risk:x');
  assert.equal(view.sinceMorning.length, 1);
  assert.equal(view.radar.length, 1);
  assert.equal(view.radar[0].domain, 'wealth');
  assert.equal(view.planConflict, null);
});

test('selectTodayCommandCenter: a present planConflict passes through verbatim', () => {
  const withConflict = {
    todayCommandCenter: {
      snapshotId: 'x', snapshotVersion: 3, snapshotAt: 'now', builtAt: 'now',
      now: { stableId: 'now:x', headline: 'h', detail: null },
      action: null, risk: null, sinceMorning: [], radar: [],
      planConflict: {
        stableId: 'planConflict:x', direction: 'rest_vs_workout',
        question: 'Which should govern?', effectiveWorkoutLabel: 'Pull', scheduledWorkoutLabel: null,
        options: [{ id: 'keep_rest', label: 'Keep rest day', workoutId: 'rest' }, { id: 'do_planned', label: 'Do Pull', workoutId: 'pull' }],
      },
    },
  } as unknown as BriefingData;
  const view = selectTodayCommandCenter(withConflict);
  assert.equal(view.planConflict?.direction, 'rest_vs_workout');
  assert.equal(view.planConflict?.options.length, 2);
});
