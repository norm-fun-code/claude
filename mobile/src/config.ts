// Backend connection. For real-device testing, set this to your Mac's local IP
// (System Settings → Wi-Fi → Details). For the simulator, localhost works.
export const API_BASE = 'http://192.168.1.4:3001';

// Optional API token — only needed if you set NORMOS_API_TOKEN on the backend
// (e.g. when hosting it on a VPS). Leave '' for local use.
export const API_TOKEN = '';

export const BRIEFING_URL = `${API_BASE}/api/briefing`;
export const HEALTH_INGEST_URL = `${API_BASE}/api/ingest/health`;
export const CHECKIN_URL = `${API_BASE}/api/checkin`;
export const CHAT_URL = `${API_BASE}/api/chat`;
export const DEVICE_REGISTER_URL = `${API_BASE}/api/devices/register`;

/** JSON headers, plus the bearer token when one is configured. */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_TOKEN) h.Authorization = `Bearer ${API_TOKEN}`;
  return h;
}
