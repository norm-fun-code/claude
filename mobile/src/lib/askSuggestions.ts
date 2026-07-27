// Deterministic, truth-safe Ask suggestion generation. Pure — no fetch, no
// React — testable with `node --experimental-strip-types --test`.
//
// Every template here is deliberately hedged: no unsupported causal
// ("predicts", "typically gets in the way") or unearned-confidence
// ("confirmed") language for anything that isn't a directly observed fact.
// Bug fix: the previous hardcoded set included "Why was my focus lower last
// week?" (asserted a fact with no check that it was true), "What habits
// predict my best weeks?" (a predictive claim with no supporting evidence),
// and "what typically gets in the way?" (a pattern claim nothing established)
// — the exact class of prompt the Ask truth-and-evidence contract forbids.
// Each suggestion here is recomputed from the CURRENT snapshot every time
// the overlay opens (never cached), so a suggestion whose underlying
// condition no longer holds (the gap closed, the streak broke) naturally
// stops being generated rather than lingering as a stale/resolved question.
export type AskSuggestionIntent = 'understand' | 'decide' | 'act';

export interface AskSuggestion {
  text: string;
  intent: AskSuggestionIntent;
}

export interface SnapData {
  wellbeing?: Record<string, { cur: number | null; prior: number | null }>;
  health?: Record<string, { cur: number | null; prior: number | null }>;
  habits?: Record<string, { rate: number | null; label: string; scale?: number; streak?: number }>;
  experiments?: { completed: unknown[]; running: Record<string, unknown>[] };
  topFindings?: { title: string }[];
}

// Always-valid regardless of current data — no presupposed fact, no
// prediction, no unearned "confirmed". Safe defaults when the snapshot is
// thin or a data-derived suggestion isn't available.
const SAFE_FALLBACKS: AskSuggestion[] = [
  { text: 'What matters most today?', intent: 'decide' },
  { text: "What's changed in my health data this week?", intent: 'understand' },
  { text: 'Is my spending on track with my plan?', intent: 'understand' },
  { text: 'Show me what NormOS is uncertain about.', intent: 'understand' },
  { text: 'What should I prioritize this week?', intent: 'decide' },
];

export function buildAskSuggestions(snap: SnapData | null): AskSuggestion[] {
  const out: AskSuggestion[] = [];
  if (snap) {
    const hrv = snap.health?.hrv;
    const sleep = snap.health?.sleep_hours;
    const energy = snap.wellbeing?.energy;
    const mood = snap.wellbeing?.mood;

    if (hrv?.cur != null && hrv.prior != null) {
      const delta = hrv.cur - hrv.prior;
      if (delta < -3) out.push({ text: `My HRV dropped ${Math.abs(Math.round(delta))}ms vs last week — what's associated with that?`, intent: 'understand' });
      else if (delta > 3) out.push({ text: `My HRV is up ${Math.round(delta)}ms this week — what changed?`, intent: 'understand' });
    }

    if (energy?.cur != null && mood?.cur != null) {
      const gap = (mood.cur ?? 0) - (energy.cur ?? 0);
      if (gap >= 0.75) out.push({ text: `My energy (${energy.cur}/5) is trailing my mood (${mood.cur}/5) — what's associated with that gap?`, intent: 'understand' });
      else if (energy.cur < 3) out.push({ text: `My energy has been ${energy.cur}/5 this week — what should I try?`, intent: 'decide' });
    }

    if (sleep?.cur != null && sleep.cur < 7.5) {
      out.push({ text: `I'm averaging ${sleep.cur}h of sleep — how does that line up with my recovery?`, intent: 'understand' });
    }

    const habits = snap.habits ?? {};
    const topStreak = Object.values(habits)
      .filter((h) => (h.streak ?? 0) >= 3)
      .sort((a, b) => (b.streak ?? 0) - (a.streak ?? 0))[0];
    if (topStreak) out.push({ text: `I've hit ${topStreak.label} for ${topStreak.streak} weeks straight — what's that been associated with?`, intent: 'understand' });

    const slipping = Object.values(habits).find((h) => !h.scale && h.rate != null && h.rate < 50);
    if (slipping) {
      const days = Math.round(((slipping.rate ?? 0) / 100) * 7);
      out.push({ text: `I only hit ${slipping.label} ${days}/7 days this week — what would help?`, intent: 'decide' });
    }

    if (snap.topFindings?.length) {
      out.push({ text: `NormOS noticed: "${snap.topFindings[0].title}" — how should I act on that?`, intent: 'decide' });
    }

    const running = snap.experiments?.running ?? [];
    const hypothesis = running[0]?.hypothesis;
    if (running.length > 0 && typeof hypothesis === 'string') {
      out.push({ text: `How is the "${hypothesis}" experiment tracking so far?`, intent: 'understand' });
    }
  }

  for (const s of SAFE_FALLBACKS) {
    if (out.length >= 5) break;
    if (!out.some((o) => o.text === s.text)) out.push(s);
  }
  return out.slice(0, 5);
}
