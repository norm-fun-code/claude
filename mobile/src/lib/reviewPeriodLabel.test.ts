// Reported (Aug 10 2026, a Monday): the weekly review's narrative cited
// "alcohol nights (Tue, Wed) and back-to-back travel (Thu, Fri)" and the
// reader objected that those "were last week not this past week". The review
// covered Aug 3-9 and its ledger episodes were Aug 4/5 (alcohol) and Aug 6/7
// (travel) — all genuinely inside that window, and Aug 5 independently
// confirmed by the user's own same-week note. The data was right; the review
// simply never said WHICH week it described, so read on the Monday after, "the
// week" sounded like the week that had just started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPeriodLabel } from './reviewPeriodLabel.ts';

const TZ = 'America/New_York';

test('required: names the exact reviewed range — the reported case', () => {
  assert.equal(reviewPeriodLabel('2026-08-03', TZ), 'Week of Aug 3–9');
});

test('required: a range straddling a month boundary names both months', () => {
  assert.equal(reviewPeriodLabel('2026-07-27', TZ), 'Week of Jul 27–Aug 2');
});

test('required: a full ISO timestamp (the server stamps period_start) is accepted', () => {
  assert.equal(reviewPeriodLabel('2026-08-03T03:13:15.285Z', TZ), 'Week of Aug 3–9');
});

test('required: the label does not drift a day in a western timezone', () => {
  // A bare YYYY-MM-DD parses as UTC midnight; formatted in ET that is the
  // PREVIOUS day unless the value is anchored mid-day.
  assert.equal(reviewPeriodLabel('2026-08-03', 'America/Los_Angeles'), 'Week of Aug 3–9');
});

test('required: a missing or unparseable weekStart renders nothing rather than a wrong week', () => {
  assert.equal(reviewPeriodLabel(null, TZ), null);
  assert.equal(reviewPeriodLabel(undefined, TZ), null);
  assert.equal(reviewPeriodLabel('', TZ), null);
  assert.equal(reviewPeriodLabel('not-a-date', TZ), null);
});
