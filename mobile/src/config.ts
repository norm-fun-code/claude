// Backend connection. Defaults to the hosted Railway backend so the app works
// anywhere (off your home WiFi, unplugged from the Mac). Override for local dev
// by setting EXPO_PUBLIC_API_BASE to your Mac's LAN IP (e.g. http://192.168.1.4:3001).
// OTA republish: ship a bundle that includes the API token.
export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE || 'https://backend-production-0902.up.railway.app';

// Backend bearer token (NORMOS_API_TOKEN on Railway). Injected at build time from
// EXPO_PUBLIC_API_TOKEN so the secret never lives in source control.
export const API_TOKEN = process.env.EXPO_PUBLIC_API_TOKEN || '';

export const BRIEFING_URL = `${API_BASE}/api/briefing`;
export const WEATHER_URL = `${API_BASE}/api/weather`;
export const HEALTH_INGEST_URL = `${API_BASE}/api/ingest/health`;
export const CHECKIN_URL = `${API_BASE}/api/checkin`;
export const CHECKIN_TODAY_URL = `${API_BASE}/api/checkin/today`;
export const INTENTIONS_URL = `${API_BASE}/api/intentions`;
export const INTENTIONS_CURRENT_URL = `${API_BASE}/api/intentions/current`;
export const INTENTIONS_RESULTS_URL = `${API_BASE}/api/intentions/results`;
export const CHAT_URL = `${API_BASE}/api/chat`;
export const DEVICE_REGISTER_URL = `${API_BASE}/api/devices/register`;
export const HIGHLIGHTS_URL = `${API_BASE}/api/highlights`;
export const SHOP_URL = `${API_BASE}/api/shop`;
export const ANALYZE_URL = `${API_BASE}/api/analyze`;
export const HABITS_STREAKS_URL = `${API_BASE}/api/habits/streaks`;
export const WORKOUT_LOG_URL = `${API_BASE}/api/workout/log`;
export const ANNOTATIONS_URL = `${API_BASE}/api/annotations`;
export const CHECKIN_HISTORY_URL = `${API_BASE}/api/checkin/history`;
export const BRIEFINGS_HISTORY_URL = `${API_BASE}/api/briefings/history`;

/** JSON headers, plus the bearer token when one is configured. */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_TOKEN) h.Authorization = `Bearer ${API_TOKEN}`;
  return h;
}

/**
 * fetch() with a hard timeout (default 20s) so a stalled request can't hang a
 * spinner forever — important since the app is meant to work off-WiFi/unplugged.
 * Throws on timeout (AbortError) just like a network failure, so callers' catch
 * blocks handle it uniformly.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 20000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
