// Presentation for the disagreement surface.
//
// The whole feature turns on tone, and tone is the easiest thing to lose in a
// component. It lives here so a test can hold it: the card reports counts and
// asks a question, and must never editorialize on top of them. "You've set
// this 6 weeks running, and marked it missed 5 of the 6 you reviewed" lands as
// candour. The same fact plus one adjective — "you *still* haven't", "you keep
// *failing*" — lands as contempt, and the surface gets muted, which costs the
// product the one thing it was for.
//
// The server (intelligence/disagreement.js) owns every decision about WHETHER
// to say anything. This module owns only how it reads.

export interface DisagreementOption {
  id: 'revise' | 'keep' | 'retire';
  label: string;
  detail: string;
}

export interface Disagreement {
  stableId: string;
  resolutionKey: string;
  kind: string;
  label: string;
  headline: string;
  detail: string;
  weeksStated: string[];
  weeksMissed: string[];
  counts: {
    statements: number;
    graded: number;
    missed: number;
    achieved: number;
    unreviewed: number;
  };
  question: string;
  options: DisagreementOption[];
  evidence: {
    source: string;
    basis: string;
    windowWeeks: number;
    unreviewedExcluded: number;
  };
}

/** "Aug 30" — anchored at midday UTC so a bare date cannot render as the
 *  previous day west of Greenwich (same fix as reviewPeriodLabel). */
export function formatWeek(weekStart: string, timeZone: string): string {
  const d = new Date(`${String(weekStart).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(weekStart);
  return d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' });
}

/**
 * The weeks it was missed, as checkable dates — capped, because a wall of
 * twenty dates reads as a charge sheet rather than evidence. The remainder is
 * counted, never hidden.
 */
export function missedWeeksLine(d: Disagreement, timeZone: string, limit = 6): string {
  const weeks = d.weeksMissed || [];
  if (!weeks.length) return '';
  const shown = weeks.slice(0, limit).map((w) => formatWeek(w, timeZone));
  const rest = weeks.length - shown.length;
  return rest > 0 ? `Weeks of ${shown.join(', ')} +${rest} more` : `Weeks of ${shown.join(', ')}`;
}

/**
 * The one line that makes the claim unarguable: this is not a proxy metric or
 * an inferred behavior, it is the reader's own goal text and their own verdict.
 * Rendered on the card, not buried in a detail view, because it is the
 * difference between candour and an app being presumptuous.
 */
export function basisLine(d: Disagreement): string {
  const unreviewed = d.evidence?.unreviewedExcluded ?? 0;
  const base = `From ${d.evidence?.basis ?? 'your own weekly reviews'}.`;
  return unreviewed > 0
    ? `${base} ${unreviewed} week${unreviewed === 1 ? '' : 's'} you didn’t review ${unreviewed === 1 ? 'is' : 'are'} not counted.`
    : base;
}

/** Words that turn a count into an accusation. Held by a test, not by taste. */
const EDITORIAL = /\b(fail(ed|ing|ure)?|lazy|excuse|should\s?(have|'ve)|again|still|never|always|disappointing|poor)\b/i;

/**
 * True when a rendered line has stayed factual. Exists so the tone contract is
 * enforceable rather than aspirational — if someone later "improves" the copy
 * into something punchier, the test fails.
 */
export function isFactualTone(text: string): boolean {
  return !EDITORIAL.test(String(text || ''));
}
