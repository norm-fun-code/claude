// Backend connection. Defaults to the hosted Railway backend so the app works
// anywhere (off your home WiFi, unplugged from the Mac). Override for local dev
// by setting EXPO_PUBLIC_API_BASE to your Mac's LAN IP (e.g. http://192.168.1.4:3001).
export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE || 'https://backend-production-0902.up.railway.app';

// Backend bearer token (NORMOS_API_TOKEN on Railway). Injected at build time from
// EXPO_PUBLIC_API_TOKEN so the secret never lives in source control.
export const API_TOKEN = process.env.EXPO_PUBLIC_API_TOKEN || '';

export const BRIEFING_URL = `${API_BASE}/api/briefing`;
export const HEALTH_INGEST_URL = `${API_BASE}/api/ingest/health`;
export const CHECKIN_URL = `${API_BASE}/api/checkin`;
export const CHAT_URL = `${API_BASE}/api/chat`;
export const DEVICE_REGISTER_URL = `${API_BASE}/api/devices/register`;
export const HIGHLIGHTS_URL = `${API_BASE}/api/highlights`;
export const SHOP_URL = `${API_BASE}/api/shop`;

/** JSON headers, plus the bearer token when one is configured. */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_TOKEN) h.Authorization = `Bearer ${API_TOKEN}`;
  return h;
}
