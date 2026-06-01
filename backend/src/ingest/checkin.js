// Maps a daily subjective check-in into canonical wellbeing metrics (+ an
// optional journal note as a document). This is the "dependent variable" that
// makes questions like spending↔happiness and calendar↔energy answerable.
//
// Body: { mood, energy, focus, note?, ts? } on a 1–5 scale (configurable).
const { dayAnchorTs } = require('../util/date');

const SOURCE = 'checkin';
const DOMAIN = 'wellbeing';
const FIELDS = { mood: 'mood', energy: 'energy', focus: 'focus' };

function mapCheckin(body = {}, { ts, tz = 'UTC' } = {}) {
  // Anchor to one stable per-day timestamp so tapping mood, then energy, then
  // re-tapping mood all upsert the same day's rows (clean signal for insights)
  // — unless an explicit ts is given (e.g. backfill).
  const when = ts || body.ts ? new Date(ts || body.ts) : dayAnchorTs(tz);
  const metrics = [];

  for (const [field, metric] of Object.entries(FIELDS)) {
    const value = Number(body[field]);
    if (Number.isFinite(value)) {
      metrics.push({ ts: when, domain: DOMAIN, metric, value, unit: 'score', source: SOURCE });
    }
  }

  let document = null;
  if (body.note && String(body.note).trim()) {
    const day = when.toISOString().slice(0, 10);
    document = {
      source: SOURCE,
      domain: DOMAIN,
      externalId: `note:${day}`,
      title: `Journal — ${day}`,
      content: String(body.note).trim(),
      occurredAt: when,
      metadata: { mood: body.mood, energy: body.energy, focus: body.focus },
    };
  }

  return { metrics, document };
}

module.exports = { mapCheckin, SOURCE, DOMAIN };
