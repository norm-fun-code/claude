import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Weather } from '../hooks/useBriefing';
import { useWeather } from '../hooks/useWeather';

interface Props {
  // The briefing's weather, used only as a seed; the card fetches/refreshes its
  // own weather independently so it loads fast and updates without the briefing.
  weather: Weather | null;
}

function getOutfitAdvice(temp: number, condition: string): { outfit: string; note: string } {
  const lower = condition.toLowerCase();
  const isRain = lower.includes('rain') || lower.includes('shower') || lower.includes('drizzle') || lower.includes('thunder');
  const isSnow = lower.includes('snow') || lower.includes('flurr');

  if (isSnow || temp <= 20) return { outfit: '🧥🧣🧤', note: 'Heavy coat, scarf, gloves' };
  if (temp <= 32) return { outfit: '🧥🧣', note: 'Heavy coat and scarf' };
  if (temp <= 45) return { outfit: isRain ? '🧥☂️' : '🧥', note: isRain ? 'Warm coat, bring umbrella' : 'Warm coat' };
  if (temp <= 55) return { outfit: isRain ? '🧤☂️' : '🧤', note: isRain ? 'Light jacket, umbrella' : 'Light jacket or fleece' };
  if (temp <= 65) return { outfit: isRain ? '👕☂️' : '👕🧥', note: isRain ? 'Layer up, umbrella' : 'Layers — warm out, cool inside' };
  if (temp <= 75) return { outfit: isRain ? '👕☂️' : '👕', note: isRain ? 'T-shirt, grab an umbrella' : 'T-shirt weather' };
  if (temp <= 85) return { outfit: '👕🕶', note: 'Light clothes, sunglasses' };
  return { outfit: '🩳🕶💧', note: 'Shorts, shades, stay hydrated' };
}

// UV exposure category (EPA scale) — turns a bare number into something actionable.
function uvLevel(uv: number): string {
  if (uv <= 2) return 'Low';
  if (uv <= 5) return 'Moderate';
  if (uv <= 7) return 'High';
  if (uv <= 10) return 'Very High';
  return 'Extreme';
}

function conditionToEmoji(condition: string): string {
  const lower = condition.toLowerCase();
  if (lower.includes('thunder')) return '⛈';
  if (lower.includes('heavy rain')) return '🌧';
  if (lower.includes('rain') || lower.includes('shower') || lower.includes('drizzle')) return '🌦';
  if (lower.includes('snow')) return '❄️';
  if (lower.includes('fog') || lower.includes('haze') || lower.includes('smoky') || lower.includes('dusty')) return '🌫';
  if (lower.includes('clear')) return '☀️';
  if (lower.includes('mostly clear') || lower.includes('mostly cloudy')) return '🌤';
  if (lower.includes('partly')) return '⛅️';
  if (lower.includes('cloudy')) return '☁️';
  if (lower.includes('windy') || lower.includes('breezy')) return '💨';
  return '🌡';
}

export function WeatherCard({ weather: seed }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const { weather, loading, refresh } = useWeather(seed);

  // A small refresh control in the card's top-right — taps re-pull just the
  // weather (fast) instead of rebuilding the whole Today briefing.
  const header = (
    <View style={styles.headerRow}>
      <SectionHeader emoji="🌤" title="Weather" />
      <TouchableOpacity onPress={refresh} disabled={loading} hitSlop={10} style={styles.refreshBtn}>
        {loading ? (
          <ActivityIndicator size="small" color={c.subtext} />
        ) : (
          <Text style={[styles.refreshIcon, { color: c.accent }]}>↻</Text>
        )}
      </TouchableOpacity>
    </View>
  );

  if (!weather) {
    return (
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        {header}
        <Text style={[styles.unavailable, { color: c.subtext }]}>
          {loading ? 'Loading weather…' : 'Weather unavailable'}
        </Text>
      </View>
    );
  }

  const emoji = conditionToEmoji(weather.condition);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      {header}

      {/* Main temperature */}
      <View style={styles.mainRow}>
        <View>
          <View style={styles.tempRow}>
            <Text style={[styles.tempLarge, { color: c.text }]}>{weather.temp}°</Text>
            <Text style={styles.conditionEmoji}>{emoji}</Text>
          </View>
          <Text style={[styles.condition, { color: c.subtext }]}>{weather.condition}</Text>
          <Text style={[styles.feelsLike, { color: c.subtext }]}>
            Feels like {weather.feelsLike}° · H:{weather.high ?? '—'}° L:{weather.low ?? '—'}°
          </Text>
        </View>

        <View style={styles.rightStats}>
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: c.text }]}>{weather.humidity}%</Text>
            <Text style={[styles.statLabel, { color: c.subtext }]}>Humidity</Text>
          </View>
          {weather.uvIndex !== null && (
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: c.text }]}>{weather.uvIndex}</Text>
              <Text style={[styles.statLabel, { color: c.subtext }]}>UV · {uvLevel(weather.uvIndex)}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Sunrise / Sunset */}
      {(weather.sunrise || weather.sunset) && (
        <View style={styles.sunRow}>
          {weather.sunrise && (
            <View style={styles.sunItem}>
              <Text style={styles.sunEmoji}>🌅</Text>
              <Text style={[styles.sunTime, { color: c.subtext }]}>{weather.sunrise}</Text>
            </View>
          )}
          {weather.sunset && (
            <View style={styles.sunItem}>
              <Text style={styles.sunEmoji}>🌇</Text>
              <Text style={[styles.sunTime, { color: c.subtext }]}>{weather.sunset}</Text>
            </View>
          )}
        </View>
      )}

      {/* Outfit recommendation */}
      {(() => {
        const { outfit, note } = getOutfitAdvice(weather.temp, weather.condition);
        return (
          <View style={[styles.outfitRow, { backgroundColor: isDark ? '#1A1A18' : '#F5F5F2', borderColor: c.border }]}>
            <Text style={styles.outfitEmoji}>{outfit}</Text>
            <Text style={[styles.outfitNote, { color: c.subtext }]}>{note}</Text>
          </View>
        );
      })()}

      {/* Hourly forecast */}
      {weather.hourly.length > 0 && (
        <>
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.hourlyContainer}
          >
            {weather.hourly.map((hour, index) => (
              <View key={index} style={styles.hourItem}>
                <Text style={[styles.hourTime, { color: c.subtext }]}>{hour.time}</Text>
                <Text style={styles.hourEmoji}>{conditionToEmoji(hour.condition)}</Text>
                <Text style={[styles.hourTemp, { color: c.text }]}>{hour.temp}°</Text>
                {hour.uvIndex != null && (
                  <Text style={[styles.hourUv, { color: c.subtext }]}>UV {hour.uvIndex}</Text>
                )}
              </View>
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  refreshBtn: {
    padding: spacing.xs,
    marginTop: spacing.xs,
    minWidth: 28,
    alignItems: 'center',
  },
  refreshIcon: {
    fontSize: 20,
    fontWeight: '600',
    lineHeight: 22,
  },
  mainRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  tempRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  tempLarge: {
    fontSize: 64,
    fontWeight: '300',
    letterSpacing: -3,
    lineHeight: 68,
  },
  conditionEmoji: {
    fontSize: 32,
    marginTop: spacing.sm,
  },
  condition: {
    ...typography.subtitle,
    marginBottom: spacing.xs,
  },
  feelsLike: {
    ...typography.caption,
    fontSize: 13,
  },
  rightStats: {
    gap: spacing.md,
    alignItems: 'flex-end',
  },
  statItem: {
    alignItems: 'flex-end',
  },
  statValue: {
    ...typography.subtitle,
    fontWeight: '600',
  },
  statLabel: {
    ...typography.caption,
  },
  sunRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginBottom: spacing.sm,
  },
  sunItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  sunEmoji: {
    fontSize: 14,
  },
  sunTime: {
    ...typography.caption,
    fontSize: 13,
  },
  divider: {
    height: 1,
    marginVertical: spacing.sm,
  },
  hourlyContainer: {
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  hourItem: {
    alignItems: 'center',
    gap: spacing.xs,
    minWidth: 52,
  },
  hourTime: {
    ...typography.caption,
    fontSize: 11,
  },
  hourEmoji: {
    fontSize: 18,
  },
  hourTemp: {
    ...typography.subtitle,
    fontSize: 15,
  },
  hourUv: {
    ...typography.caption,
    fontSize: 10,
  },
  unavailable: {
    ...typography.body,
    fontStyle: 'italic',
    paddingVertical: spacing.sm,
  },
  outfitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
    marginBottom: spacing.sm,
  },
  outfitEmoji: {
    fontSize: 20,
    letterSpacing: 2,
  },
  outfitNote: {
    ...typography.caption,
    fontSize: 13,
    flex: 1,
  },
});
