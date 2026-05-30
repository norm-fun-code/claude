// Backend connection. For real-device testing, set this to your Mac's local IP
// (System Settings → Wi-Fi → Details). For the simulator, localhost works.
export const API_BASE = 'http://192.168.1.4:3001';

export const BRIEFING_URL = `${API_BASE}/api/briefing`;
export const HEALTH_INGEST_URL = `${API_BASE}/api/ingest/health`;
export const CHECKIN_URL = `${API_BASE}/api/checkin`;
export const CHAT_URL = `${API_BASE}/api/chat`;
export const DEVICE_REGISTER_URL = `${API_BASE}/api/devices/register`;
