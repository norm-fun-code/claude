// Estimated steps & active energy for activities logged WITHOUT a watch.
//
// When you log "Basketball, 90 min" on a day you didn't wear the Apple Watch,
// the watch undercounts steps and active energy. This fills the gap from the
// logged type + duration so the day's totals stay honest.
//
// Energy uses the standard MET equation:
//   kcal = MET × 3.5 × bodyWeightKg ÷ 200 × minutes
// MET values are from the Compendium of Physical Activities (moderate intensity).
// stepsPerMin is a calibrated movement estimate — 0 for non-ambulatory activities
// (cycling, swimming, rowing) where steps aren't a meaningful proxy.
const CATALOG = {
  // mobile ACTIVITY_TYPES ids
  walk:       { met: 3.5,  spm: 110, label: 'Walk' },
  zone2:      { met: 6.0,  spm: 120, label: 'Zone 2' },
  run:        { met: 9.8,  spm: 160, label: 'Run' },
  strength:   { met: 5.0,  spm: 15,  label: 'Strength' },
  intervals:  { met: 8.5,  spm: 130, label: 'Intervals' },
  mobility:   { met: 2.5,  spm: 10,  label: 'Mobility' },
  rest:       { met: 1.0,  spm: 0,   label: 'Rest' },
  // recreational / sport
  basketball: { met: 6.5,  spm: 130, label: 'Basketball' },
  soccer:     { met: 7.0,  spm: 135, label: 'Soccer' },
  tennis:     { met: 7.3,  spm: 110, label: 'Tennis' },
  pickleball: { met: 6.0,  spm: 100, label: 'Pickleball' },
  dance:      { met: 5.5,  spm: 90,  label: 'Dancing' },
  hike:       { met: 6.0,  spm: 115, label: 'Hike' },
  golf:       { met: 4.8,  spm: 90,  label: 'Golf (walking)' },
  ski:        { met: 7.0,  spm: 40,  label: 'Ski / snowboard' },
  box:        { met: 7.8,  spm: 50,  label: 'Boxing' },
  climb:      { met: 8.0,  spm: 25,  label: 'Climbing' },
  elliptical: { met: 5.0,  spm: 120, label: 'Elliptical' },
  yoga:       { met: 2.5,  spm: 8,   label: 'Yoga' },
  pilates:    { met: 3.0,  spm: 10,  label: 'Pilates' },
  // non-ambulatory (energy only, no step proxy)
  swim:       { met: 7.0,  spm: 0,   label: 'Swim' },
  cycle:      { met: 7.5,  spm: 0,   label: 'Cycling' },
  row:        { met: 7.0,  spm: 0,   label: 'Rowing' },
  jump_rope:  { met: 11.0, spm: 0,   label: 'Jump rope' },
  sport:      { met: 6.5,  spm: 110, label: 'Sport' },
};

// Unknown types fall back to a light-moderate generic estimate.
const DEFAULT = { met: 4.0, spm: 60 };
const DEFAULT_WEIGHT_LB = Number(process.env.ACTIVITY_EST_WEIGHT_LB) || 170;
const LB_TO_KG = 0.45359237;

/**
 * Estimate steps and active-energy for one logged activity.
 * @returns {{ steps:number, kcal:number, met:number|null }}
 */
function estimateActivity({ type, minutes, weightLb } = {}) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return { steps: 0, kcal: 0, met: null };
  const a = CATALOG[String(type || '').toLowerCase()] || DEFAULT;
  const weightKg = (Number(weightLb) > 0 ? Number(weightLb) : DEFAULT_WEIGHT_LB) * LB_TO_KG;
  const kcal = Math.round((a.met * 3.5 * weightKg) / 200 * m);
  const steps = Math.round(a.spm * m);
  return { steps, kcal, met: a.met ?? null };
}

module.exports = { CATALOG, DEFAULT, estimateActivity, DEFAULT_WEIGHT_LB };
