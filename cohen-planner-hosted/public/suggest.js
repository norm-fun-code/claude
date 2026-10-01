'use strict';
// ═══ SUGGESTIONS ═══
// What a good advisor would say on reading this plan: the costs that arrive with the events the
// plan already knows about, and lines that look out of step with the household they are for.
//
// HOW MUCH TO TRUST THIS. Every range below is a rule of thumb for a high-cost metro, rounded and
// deliberately wide. They are not measurements of this family and they are not the model's own
// working — they exist to prompt a question ("is $4K of clothing for five people right?"), never to
// answer one. Nothing here changes the plan until a suggestion is accepted, every amount is
// editable first, and an accepted one is a named, removable item. The numbers live in this one
// place so they can be corrected without touching any screen.

(function (root) {
  // Rough yearly ranges per person, for a household in a high-cost metro.
  const BANDS = {
    groceries: { per: [3500, 8000], noun: 'groceries' },
    clothing: { per: [900, 3000], noun: 'clothing' },
    medical: { per: [1200, 5000], noun: 'out-of-pocket medical' },
    dining: { per: [1500, 6500], noun: 'dining out' },
    shopping: { per: [1200, 5500], noun: 'shopping' },
    entertainment: { per: [500, 2800], noun: 'entertainment' },
    vacations: { per: [2500, 12000], noun: 'vacations' },
  };
  // Home upkeep, as a share of the home's value each year. 1–2% is the usual rule of thumb.
  const UPKEEP = [0.01, 0.02];
  // Starting points, each editable before it is added. Round, because false precision here would
  // be dishonest: a bar mitzvah can cost a tenth or ten times this.
  const DEFAULTS = {
    babyGear: 6000, camp: 8000, barMitzvah: 25000, furnishingShare: 0.015,
  };
  const CAMP_AGES = [5, 12], MITZVAH_AGE = 13;

  const kidsOf = P => {
    const births = [P.kid1Birth, P.kid2Birth, P.kid3Birth, P.kid4Birth].slice(0, Math.max(0, Math.min(4, Number(P.numKids) || 0)));
    return births.map((b, i) => ({ n: i + 1, birth: Number(b) })).filter(k => Number.isFinite(k.birth));
  };
  // A baby does not eat or wear what an adult does, so children count for part of a person by age.
  // The weights are as rough as the ranges they scale; they only stop a newborn being measured as
  // a third adult.
  const weight = age => (age < 2 ? 0.3 : age < 6 ? 0.6 : age < 13 ? 0.85 : 1);
  const children = (P, yr) => kidsOf(P).filter(k => yr >= k.birth && yr - k.birth < 18).map(k => yr - k.birth);
  const people = (P, yr) => 2 + children(P, yr).reduce((t, a) => t + weight(a), 0);
  const household = (P, yr) => {
    const c = children(P, yr).length;
    return c === 0 ? '2 adults' : `2 adults and ${c === 1 ? 'a child' : c + ' children'}`;
  };
  const owns = (P, yr) => P.housingMode !== 'rent' && yr >= Number(P.homePurchaseYear);
  const round1k = v => Math.round(v / 1000) * 1000;
  const money = v => '$' + Math.round(v).toLocaleString('en-US');

  // Is this line out of step with the household it is for? Quiet when it is in range.
  function checks(P, R, year) {
    const row = R.find(r => r.yr === year);
    if (!row) return [];
    const n = people(P, year), out = [];
    for (const [line, b] of Object.entries(BANDS)) {
      const v = (row.livFullParts || {})[line];
      if (!Number.isFinite(v)) continue;
      const lo = b.per[0] * n, hi = b.per[1] * n;
      const who = household(P, year), rl = round1k(lo), rh = round1k(hi);
      if (v < lo) out.push({ id: `chk-${line}-${year}`, line, status: 'low', value: v, lo, hi, people: n,
        text: `${money(v)} of ${b.noun} for ${who} is below the usual ${money(rl)}–${money(rh)} for a high-cost metro.` });
      else if (v > hi) out.push({ id: `chk-${line}-${year}`, line, status: 'high', value: v, lo, hi, people: n,
        text: `${money(v)} of ${b.noun} for ${who} is above the usual ${money(rl)}–${money(rh)} for a high-cost metro.` });
    }
    return out;
  }

  const kid = k => `Kid ${k.n}`;
  function events(P, year, span) {
    const to = year + (span == null ? 2 : span), out = [];
    const add = e => { if (e.year >= year && e.year <= to) out.push(e); };
    const py = Number(P.homePurchaseYear), price = Number(P.homePrice) || 0;

    if (P.housingMode !== 'rent' && Number.isFinite(py)) {
      const amount = round1k(price * DEFAULTS.furnishingShare);
      add({ id: `home-furnish-${py}`, year: py, kind: 'item', title: 'Furnishing and move-in',
        why: 'Closing costs are already in the plan. Furniture, fixes and the first-year surprises of a house are not.',
        item: { label: 'Furnishing and move-in', category: 'oneoff', from: py, to: py, amount, grow: false }, range: [round1k(price * 0.01), round1k(price * 0.03)] });
      const upkeepFloor = round1k(price * UPKEEP[0]);
      if ((Number(P.maintBase) || 0) < price * UPKEEP[0])
        add({ id: `home-upkeep-${py}`, year: py, kind: 'param', title: 'Home upkeep looks light',
          why: `The plan sets aside ${money(P.maintBase || 0)} a year for maintenance. Upkeep on a ${money(price)} home usually runs 1–2% of its value (${money(price * UPKEEP[0])}–${money(price * UPKEEP[1])}).`,
          param: { key: 'maintBase', value: upkeepFloor, from: Number(P.maintBase) || 0 }, range: [round1k(price * UPKEEP[0]), round1k(price * UPKEEP[1])] });
    }
    for (const k of kidsOf(P)) {
      add({ id: `baby-gear-${k.n}-${k.birth}`, year: k.birth, kind: 'item', title: `${kid(k)} arrives`,
        why: 'The plan adds childcare and each child\'s ongoing costs. The one-time costs of a new baby — gear, the first-year extras — are not in it.',
        item: { label: `${kid(k)} — baby gear and first-year extras`, category: 'oneoff', from: k.birth, to: k.birth, amount: DEFAULTS.babyGear, grow: false }, range: [3000, 12000] });
      add({ id: `camp-${k.n}-${k.birth}`, year: k.birth + CAMP_AGES[0], kind: 'item', title: `${kid(k)} is old enough for camp`,
        why: `Once school starts, summers need covering. Camp is not in the plan, and in a high-cost metro it often runs $6K–$15K a summer.`,
        item: { label: `${kid(k)} — summer camp`, category: 'entertainment', from: k.birth + CAMP_AGES[0], to: k.birth + CAMP_AGES[1], amount: DEFAULTS.camp, grow: true }, range: [6000, 15000], perYear: true });
      add({ id: `mitzvah-${k.n}-${k.birth}`, year: k.birth + MITZVAH_AGE, kind: 'item', title: `${kid(k)} turns 13`,
        why: 'A bar or bat mitzvah is a one-off the plan does not include. The range is very wide — from a small kiddush to a large event.',
        item: { label: `${kid(k)} — bar/bat mitzvah`, category: 'oneoff', from: k.birth + MITZVAH_AGE, to: k.birth + MITZVAH_AGE, amount: DEFAULTS.barMitzvah, grow: false }, range: [10000, 60000] });
    }
    return out.sort((a, b) => a.year - b.year || a.id.localeCompare(b.id));
  }

  // What is left to decide: not yet added, not dismissed.
  function pending(P, year, span) {
    const done = new Set([...(P.budgetDismissed || []), ...(P.planItems || []).map(i => i.sid).filter(Boolean)]);
    return events(P, year, span).filter(e => !done.has(e.id));
  }

  const api = { BANDS, UPKEEP, DEFAULTS, CAMP_AGES, MITZVAH_AGE, kidsOf, people, household, owns, checks, events, pending };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerSuggest = api;
})(typeof window !== 'undefined' ? window : this);
