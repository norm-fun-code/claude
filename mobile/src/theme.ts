// Stripe-inspired palette: blurple accent (#635BFF), deep navy ink (#0A2540),
// soft light background (#F6F9FC). Light-first for readability.
export const colors = {
  background: '#F6F9FC', // Stripe light
  card: '#FFFFFF',
  border: '#E6EBF1', // Stripe hairline
  text: '#0A2540', // Stripe navy ink
  subtext: '#425466', // Stripe slate
  accent: '#635BFF', // Stripe blurple
  accentSoft: '#EFEEFF', // tint for accent backgrounds
  green: '#00A86B',
  yellow: '#E8A400',
  red: '#E25950',
  // Dark mode variants (navy, not black — keeps the Stripe feel)
  backgroundDark: '#0A2540',
  cardDark: '#0E2E4D',
  borderDark: '#1F3A5F',
  textDark: '#F6F9FC',
  subtextDark: '#8C9CB3',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 6,
  md: 12,
  lg: 16,
};

export const typography = {
  largeNumber: {
    fontSize: 56,
    fontWeight: '300' as const,
    letterSpacing: -2,
  },
  title: {
    fontSize: 22,
    fontWeight: '600' as const,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: '500' as const,
  },
  body: {
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 22,
  },
  caption: {
    fontSize: 12,
    fontWeight: '400' as const,
    letterSpacing: 0.2,
  },
  label: {
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  },
};

export function getColors(isDark: boolean) {
  return {
    background: isDark ? colors.backgroundDark : colors.background,
    card: isDark ? colors.cardDark : colors.card,
    border: isDark ? colors.borderDark : colors.border,
    text: isDark ? colors.textDark : colors.text,
    subtext: isDark ? colors.subtextDark : colors.subtext,
    accent: colors.accent, // blurple in both modes
    accentSoft: isDark ? colors.borderDark : colors.accentSoft,
    green: colors.green,
    yellow: colors.yellow,
    red: colors.red,
  };
}
