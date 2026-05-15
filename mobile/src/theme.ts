export const colors = {
  background: '#F9F8F6',
  card: '#FFFFFF',
  border: '#EAEAEA',
  text: '#1A1A1A',
  subtext: '#666666',
  accent: '#000000',
  green: '#22C55E',
  yellow: '#EAB308',
  red: '#EF4444',
  // Dark mode variants
  backgroundDark: '#111110',
  cardDark: '#1C1C1A',
  borderDark: '#2A2A28',
  textDark: '#F0EFE9',
  subtextDark: '#9A9A90',
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
    accent: isDark ? colors.textDark : colors.accent,
    green: colors.green,
    yellow: colors.yellow,
    red: colors.red,
  };
}
