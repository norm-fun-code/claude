// Apple iOS system palette — off-white grouped background, clean white cards,
// one brand accent (blurple). Typography and spacing follow SF Pro conventions.
export const colors = {
  background: '#F2F2F7',           // iOS systemGroupedBackground
  card: '#FFFFFF',                  // iOS secondarySystemGroupedBackground
  border: 'rgba(60,60,67,0.12)',    // iOS separator — hairline dividers inside cards
  text: '#1C1C1E',                  // iOS label
  subtext: '#8E8E93',               // iOS secondaryLabel
  accent: '#635BFF',                // brand blurple
  accentSoft: '#EFEEFF',            // blurple tint for active states
  green: '#34C759',                 // iOS systemGreen
  yellow: '#FF9F0A',                // iOS systemYellow
  red: '#FF3B30',                   // iOS systemRed
  // Recovery presentation tiers (backend intelligence/recoveryPresentation.js)
  // — a near-green score (55-62, canonically still 'yellow') gets its own
  // warm green/lime so it visually reads as reassuring, not identical to a
  // score of 40. `amber` aliases `yellow` (the "moderate" tier, 40-54, is the
  // same canonical yellow color as before) — named separately so presentation
  // consumers reference the semantic tier color, not the raw band color.
  warmGreen: '#8BC34A',
  amber: '#FF9F0A',
  // Same violet as tileTint.violet below — the ONE canonical "ready/new
  // artifact" purple (used by RadarSection/RadarDetailSheet's 'ready'
  // status). Deliberately distinct from BriefCard's own hardcoded #A89CFF —
  // that's a separate, more saturated brand accent scoped to the Chief
  // Brief hero card's own identity, not a shared semantic-status color.
  purple: '#A78BFA',
  hero: '#1C1C1E',                  // dark surface for hero cards (BriefCard etc.)
  // A second, distinct "confirmed/learned" green — used by Beliefs/Memory/
  // Workouts for a "this is settled, not just currently positive" meaning,
  // deliberately different from the on-track `green` above. Named here so
  // it's a real token instead of a magic value independently copy-pasted
  // into each of those files.
  confirmedGreen: '#1D9E75',
  // A bumped-legibility dark-mode secondary text color — used where the
  // standard `subtextDark` reads too faint against a pure-black background
  // for a given block of body copy.
  subtextStrong: '#AEAEB2',
  // Shared light/dark input-field background pair (text inputs, editable
  // rows) — distinct from `card`/`cardDark` so an editable surface reads as
  // subtly different from a static card.
  inputBackground: '#F9F8F6',
  inputBackgroundDark: '#1C1C1A',
  // Dark mode
  backgroundDark: '#000000',
  cardDark: '#1C1C1E',
  borderDark: 'rgba(255,255,255,0.1)',
  textDark: '#FFFFFF',
  subtextDark: '#8E8E93',
};

// Signature band gradients for the recovery orb (and future state visuals) —
// a light, alive top color into a saturated core. The "wow" comes from depth +
// motion + a colored glow, not flat fills.
export const bandGradient: Record<string, [string, string]> = {
  green: ['#5AE89A', '#16A34A'],
  yellow: ['#FFC44D', '#F59E0B'],
  red: ['#FF8478', '#EF4444'],
  neutral: ['#B7B7C2', '#7C7C88'],
  // Recovery presentation tiers — 'warmGreen' (near-green, 55-62) reads as
  // reassuring rather than sharing 'yellow's cautionary gradient; 'amber'
  // aliases 'yellow' (the 'moderate' tier, 40-54, keeps the original look).
  warmGreen: ['#C6E88A', '#8BC34A'],
  amber: ['#FFC44D', '#F59E0B'],
};

// Overlay a hex color at a given alpha. Used for the tinted "app-icon" tiles
// behind section-header emoji and other soft accent fills, so one base color
// yields both its solid form and a subtle wash without hand-writing rgba().
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Named tints for section-header emoji tiles — a small, controlled palette so
// each domain's tile reads as intentional (Apple-Settings-style colored chips)
// rather than a rainbow. Header defaults to 'accent'; hero cards opt into their
// domain color. Keyed values are the vivid base; the tile derives its soft
// fill + hairline from it via withAlpha.
export const tileTint: Record<string, string> = {
  accent: '#635BFF',
  green: '#34C759',
  gold: '#FF9F0A',
  red: '#FF6B6B',
  blue: '#3B9EFF',
  violet: '#A78BFA',
};

// A soft, color-tinted glow — the premium "lit from within" feel for hero
// elements. iOS renders the colored shadow; Android falls back to a neutral
// elevation.
export function glow(color: string, intensity = 0.5, r = 20) {
  return {
    shadowColor: color,
    shadowOpacity: intensity,
    shadowRadius: r,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  };
}

export const spacing = {
  // Sits between xs(4) and sm(8) — the common "tight" gap/padding value
  // (pill/chip internals, compact icon rows) that was previously scattered
  // as a raw `6` across a dozen components.
  xxs: 6,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  pill: 999,
};

// Minimum interactive-element sizing (iOS HIG: 44x44pt minimum tap target)
// and the handful of icon-container diameters that already recur 2-3x each
// across the app as independently-copy-pasted magic numbers (FAB/orb-scale
// controls, section-header emoji tiles, mid-size icon buttons).
export const sizes = {
  minTouchTarget: 44,
  iconTile: 30,   // SectionHeader's emoji tile
  iconMd: 40,     // step buttons, orb core, etc.
  iconLg: 52,     // FAB, forecast icon, voice control buttons
  orb: 96,        // TalkOverlay's voice orb — the largest icon-like element
};

// Animation durations/easing + spring presets — consolidates the dozen+
// independently-chosen duration values found across components into a
// small named scale. Components remain free to use raw Animated/Reanimated
// APIs; this just gives them one shared vocabulary to reach for instead of
// re-guessing a number each time.
export const motion = {
  fast: 180,
  base: 320,
  slow: 550,
  springSnappy: { damping: 22, stiffness: 280 },
  springGentle: { damping: 15, stiffness: 220 },
};

// Layout constants tying the floating Ask/voice FAB to the bottom tab bar —
// named here (instead of only in a code comment) so the two components that
// must agree on this clearance (TabBar's height, AskOverlay's FAB position)
// reference one source instead of independently-hardcoded numbers that can
// silently drift apart.
export const layout = {
  fabSize: sizes.iconLg,
  // Vertical gap from the safe-area bottom inset to the FAB's own bottom
  // edge — chosen so the FAB's top edge clears the tab bar's top edge by
  // ~60pt across supported iPhone sizes (see AskOverlay.tsx's fabWrap).
  fabBottomGap: 70,
  // The small drag-handle bar every hand-rolled bottom sheet in the app
  // independently redraws at the same 36x4/radius-2 dimensions.
  sheetHandle: { width: 36, height: 4, borderRadius: 2 },
};

// The brand's signature gradient — used on primary CTAs and accents.
export const accentGradient: [string, string] = ['#7A73FF', '#5A52F0'];

// Custom type hook points. UNDEFINED = system face (SF Pro) — safe to ship as-is.
// After the native font install (see DESIGN_NATIVE_SETUP.md), set these to the
// loaded family names and the whole app adopts the custom type in one edit:
//   display: 'Sora_700Bold'  ·  text: 'Inter_400Regular'
export const FONTS: { display?: string; text?: string; displayHeavy?: string; displayLight?: string } = {
  display: 'Sora_700Bold',        // headlines + titles
  text: 'Inter_400Regular',       // body, captions, labels
  displayHeavy: 'Sora_800ExtraBold', // orb / grade focal numbers
  displayLight: 'Sora_300Light',  // big marquee numbers (elegant + geometric)
};

export const typography = {
  largeNumber: {
    fontFamily: FONTS.display,
    fontSize: 56,
    fontWeight: '300' as const,
    letterSpacing: -2,
  },
  // Hero metric — the number a card is *about* (recovery score, net worth, a
  // chip value). Tabular figures so digits don't jitter as values change, and
  // a big enough jump from body text that the eye lands on it first. Two sizes
  // fill the gap between largeNumber (56, marquee) and subtitle (17).
  metric: {
    fontFamily: FONTS.displayHeavy,
    fontSize: 34,
    fontWeight: '700' as const,
    letterSpacing: -1,
    fontVariant: ['tabular-nums' as const],
  },
  metricSmall: {
    fontFamily: FONTS.displayHeavy,
    fontSize: 22,
    fontWeight: '700' as const,
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums' as const],
  },
  title: {
    fontFamily: FONTS.display,
    fontSize: 28,
    fontWeight: '700' as const,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: FONTS.text,
    fontSize: 17,
    fontWeight: '600' as const,
    letterSpacing: -0.2,
  },
  body: {
    fontFamily: FONTS.text,
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 22,
  },
  caption: {
    fontFamily: FONTS.text,
    fontSize: 13,
    fontWeight: '400' as const,
    letterSpacing: 0.1,
  },
  label: {
    fontFamily: FONTS.text,
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
  },
};

// Apple-style elevation: pure black at low opacity, tight radius shadow.
// Cards float off a grouped background — no visible border needed.
export function shadow(isDark: boolean, level: 'card' | 'bar' = 'card') {
  if (isDark) return {};
  const card = {
    // Soft, large, slightly cool-tinted drop — a "lifted glass" float rather than
    // a hard iOS-default shadow, so the light cards feel of-a-piece with the
    // premium hero cards.
    shadowColor: '#15172B',
    shadowOpacity: 0.09,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  };
  const bar = {
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -1 },
    elevation: 16,
  };
  return level === 'bar' ? bar : card;
}

export function getColors(isDark: boolean) {
  return {
    background: isDark ? colors.backgroundDark : colors.background,
    card: isDark ? colors.cardDark : colors.card,
    border: isDark ? colors.borderDark : colors.border,
    text: isDark ? colors.textDark : colors.text,
    subtext: isDark ? colors.subtextDark : colors.subtext,
    subtextStrong: isDark ? colors.subtextStrong : colors.subtext,
    accent: colors.accent,
    accentSoft: isDark ? 'rgba(99,91,255,0.2)' : colors.accentSoft,
    green: colors.green,
    yellow: colors.yellow,
    red: colors.red,
    warmGreen: colors.warmGreen,
    amber: colors.amber,
    purple: colors.purple,
    confirmedGreen: colors.confirmedGreen,
    hero: colors.hero,
    inputBackground: isDark ? colors.inputBackgroundDark : colors.inputBackground,
  };
}

// ── Semantic status contract ────────────────────────────────────────────
// One shared vocabulary for "what kind of thing is this fact," applied
// consistently to dots, headlines, metric deltas, cards, pills, and detail
// sheets — see individual card severity maps (WealthPostureCard,
// HealthStateCard, RadarSection's radarPresentation.ts, etc.) for domain-
// specific tiers layered ON TOP of this; this is the base 5-way contract
// those richer maps should resolve down to, not a replacement for them.
//   positive — on track / confirmed good
//   watch    — worth watching, provisional, or moderate (never alarming)
//   critical — genuinely needs attention
//   info     — neutral intelligence, navigation, or action (not a verdict)
//   neutral  — secondary, unavailable, stale, or disabled
export type SemanticStatus = 'positive' | 'watch' | 'critical' | 'info' | 'neutral';

export function statusColor(status: SemanticStatus, c: ReturnType<typeof getColors>): string {
  switch (status) {
    case 'positive': return c.green;
    case 'watch': return c.amber;
    case 'critical': return c.red;
    case 'info': return c.purple;
    default: return c.subtext;
  }
}
