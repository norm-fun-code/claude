// Presentation for the Precedent card ("you've been here before").
//
// All of it is pure, and all of it is here rather than inline in the
// component, for the same reason every other lib/ module in this app exists:
// the test runner strips TypeScript types but cannot render a React tree, so
// logic that must never regress has to live somewhere a test can call it.
//
// The backend (intelligence/precedent.js) owns every gate on WHETHER there is
// anything to say. This module owns only HOW it reads, and carries one rule of
// its own: the copy may never overstate what the projection contains. It says
// what happened on real, dated days; it never says what will happen, and it
// never tells the reader what to do. A comparison the server withheld is
// simply absent here — never softened into "you might want to…".

/** The projection shape returned by GET /api/precedent. */
export interface PrecedentStateItem {
  key: string;
  label: string;
  z: number;
  value: number | null;
  direction: 'above' | 'below';
}

export interface PrecedentDay {
  day: string;
  similarity: number;
  sharedFeatures: number;
  recovery: number | null;
  nextDayDelta: number | null;
  load: number | null;
  /** What was going on that night ("Drinking", "Travel"). Empty means nothing
   *  was recorded — never rendered as a claim that the night was quiet. */
  context: string[];
}

export interface PrecedentArm {
  n: number;
  days: string[];
  meanNextDayDelta: number;
  meanLoad: number;
}

export interface PrecedentComparison {
  cutoff: number;
  lighter: PrecedentArm;
  harder: PrecedentArm;
}

export interface Precedent {
  asOf: string;
  count: number;
  earliest: string;
  latest: string;
  state: PrecedentStateItem[];
  /** Last night's recorded context, same vocabulary as each precedent's. */
  context: string[];
  precedents: PrecedentDay[];
  comparison: PrecedentComparison | null;
  evidence: {
    minSimilarity: number;
    minSharedFeatures: number;
    baselineDays: number;
    withOutcome: number;
    leverMetric: string;
    outcomeMetric: string;
    contextConcepts?: string[];
  };
}

/** "Aug 29" for a YYYY-MM-DD day. Anchored at midday UTC so a bare date
 *  cannot render as the previous day west of Greenwich — the same fix
 *  reviewPeriodLabel applies. */
export function formatDay(day: string, timeZone: string): string {
  const d = new Date(`${String(day).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(day);
  return d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' });
}

/** The window the evidence spans — stated on the card so a set drawn from one
 *  fortnight is never mistaken for one drawn from six months. */
export function formatWindow(p: Pick<Precedent, 'earliest' | 'latest'>, timeZone: string): string {
  return `${formatDay(p.earliest, timeZone)} – ${formatDay(p.latest, timeZone)}`;
}

/**
 * A signed recovery movement. Recovery is a 0-100 score, so the sign carries
 * the whole meaning and must never be dropped; a true zero is spelled out
 * rather than rendered as a bare "0" that reads like missing data.
 */
export function formatDelta(delta: number): string {
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return 'no change';
  // U+2212 MINUS SIGN, not a hyphen — it aligns with the digits and cannot be
  // misread as a dash at small sizes.
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

/** How far from normal, in plain words. Deliberately coarse: reporting "1.9σ"
 *  to a person reading their phone at 7am is precision without meaning, and
 *  the exact z travels in the detail view for anyone who wants it. */
export function magnitudeWord(z: number): string {
  const a = Math.abs(z);
  if (a >= 2) return 'far';
  if (a >= 1) return 'well';
  return 'slightly';
}

/**
 * One honest phrase per distinctive feature, e.g. "HRV far below usual (38)".
 * The observed value rides along so the claim can be checked against memory.
 */
export function describeStateItem(item: PrecedentStateItem): string {
  const dir = item.direction === 'above' ? 'above' : 'below';
  const base = `${item.label} ${magnitudeWord(item.z)} ${dir} usual`;
  return item.value == null ? base : `${base} (${item.value})`;
}

/** The card's one-line "similar HOW?" answer. */
export function stateSummary(state: PrecedentStateItem[], limit = 3): string {
  const parts = (state || []).slice(0, limit).map(describeStateItem);
  if (!parts.length) return '';
  return `${parts.join(', ')}.`;
}

/** "12 mornings like this one" — never "12 mornings like this", which reads as
 *  a claim about the count of similar days in all of history rather than the
 *  count actually retrieved. */
export function headlineCount(count: number): string {
  return count === 1 ? '1 morning like this one' : `${count} mornings like this one`;
}

export interface ArmLine {
  /** "The 5 times you kept the day lighter" */
  label: string;
  /** "+8" */
  delta: string;
  /** Signed, for coloring. Never used to decide what the user should do. */
  direction: 'up' | 'down' | 'flat';
  n: number;
  days: string[];
}

/**
 * The two arms of the comparison, lighter first.
 *
 * "Lighter"/"harder" are relative to the median load of THESE days, which is
 * what the server split on — so the wording says "than usual on days like
 * this", never an absolute claim about what counts as a hard day.
 */
export function comparisonLines(comparison: PrecedentComparison | null): ArmLine[] | null {
  if (!comparison) return null;
  const line = (arm: PrecedentArm, label: string): ArmLine => ({
    label: `The ${arm.n} ${arm.n === 1 ? 'time' : 'times'} you ${label}`,
    delta: formatDelta(arm.meanNextDayDelta),
    direction: arm.meanNextDayDelta > 0 ? 'up' : arm.meanNextDayDelta < 0 ? 'down' : 'flat',
    n: arm.n,
    days: arm.days,
  });
  return [
    line(comparison.lighter, 'kept the day lighter'),
    line(comparison.harder, 'went harder'),
  ];
}

/**
 * The standing caveat under the comparison. Present WHENEVER a comparison is,
 * because the comparison is the part of this card a reader is most likely to
 * over-read as advice or as causation.
 */
export const COMPARISON_CAVEAT =
  'What happened, not what will. These are averages across similar past days, not a prediction or a recommendation.';

/** The footer under the precedent set — states the method plainly so the whole
 *  card is auditable rather than magical. */
export function methodNote(p: Precedent, timeZone: string): string {
  return `Matched on your overnight readings against a ${p.evidence.baselineDays}-day rolling baseline, from ${formatWindow(p, timeZone)}.`;
}

/**
 * "after drinking and a late meal" — the context of one night, as a phrase that
 * can sit inside a sentence.
 *
 * Returns null for an empty list rather than a stand-in like "a quiet night".
 * Nothing recorded means nothing is known about that night, which is not the
 * same claim, and the card must not upgrade one into the other.
 */
export function contextPhrase(context: string[] | undefined): string | null {
  const items = (context || []).filter(Boolean).map((c) => c.toLowerCase());
  if (!items.length) return null;
  if (items.length === 1) return `after ${items[0]}`;
  const last = items[items.length - 1];
  return `after ${items.slice(0, -1).join(', ')} and ${last}`;
}

/** The closest single precedent, for the card's most concrete line. Returns
 *  null unless that day carries a real outcome — a "closest match" with no
 *  recorded next day says nothing worth the space. */
export function closestWithOutcome(p: Precedent): PrecedentDay | null {
  return (p.precedents || []).find((d) => d.nextDayDelta != null) ?? null;
}
