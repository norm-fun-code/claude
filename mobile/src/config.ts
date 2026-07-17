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
export const BRIEFING_REBUILD_URL = `${API_BASE}/api/briefing/rebuild`;
// Fast, scoped retry for just the Chief-of-Staff card (seconds, not the full
// 60-90s rebuild) — see src/routes/briefing.js's chief-brief/rebuild route.
export const CHIEF_BRIEF_REBUILD_URL = `${API_BASE}/api/briefing/chief-brief/rebuild`;
export const BRIEFING_AUDIO_URL = `${API_BASE}/api/briefing/audio`;
export const VOICE_ASK_URL = `${API_BASE}/api/voice/ask`;
export const VOICE_TRANSCRIBE_URL = `${API_BASE}/api/voice/transcribe`;
// Talk to NormOS — live OpenAI Realtime voice mode. The mobile client
// connects DIRECTLY to OpenAI over WebRTC (see REALTIME_CALLS_URL below);
// these backend endpoints only mint the short-lived session secret, relay
// tool calls, persist transcripts, and log latency (never audio).
export const REALTIME_SESSION_URL = `${API_BASE}/api/voice/realtime/session`;
export const REALTIME_TOOL_URL = `${API_BASE}/api/voice/realtime/tool`;
export const REALTIME_TURN_URL = `${API_BASE}/api/voice/realtime/turn`;
export const REALTIME_METRIC_URL = `${API_BASE}/api/voice/realtime/metric`;
// OpenAI's own WebRTC SDP-exchange endpoint — the mobile client POSTs its SDP
// offer here directly, authenticated with the ephemeral secret (never the
// permanent key). Model is appended as a query param by the caller.
export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
// Staged-rollout flag, independent of whether the native WebRTC module is
// actually present in this binary (lib/realtimeVoice.ts's own
// `realtimeVoiceAvailable` check) — lets a bad rollout be dialed back via an
// EAS env change without a new build, same spirit as the backend's
// VOICE_REALTIME_ENABLED kill switch.
export const REALTIME_VOICE_ENABLED = process.env.EXPO_PUBLIC_REALTIME_VOICE_ENABLED !== 'false';
export const EVENING_BRIEF_URL = `${API_BASE}/api/evening-brief`;
export const EVENING_BRIEF_AUDIO_URL = `${API_BASE}/api/evening-brief/audio`;
export const WISDOM_AUDIO_URL = `${API_BASE}/api/wisdom/audio`;
export const HEALTH_INGEST_URL = `${API_BASE}/api/ingest/health`;
export const CHECKIN_URL = `${API_BASE}/api/checkin`;
export const CHECKIN_TODAY_URL = `${API_BASE}/api/checkin/today`;
export const INTENTIONS_URL = `${API_BASE}/api/intentions`;
export const INTENTIONS_CURRENT_URL = `${API_BASE}/api/intentions/current`;
export const INTENTIONS_RESULTS_URL = `${API_BASE}/api/intentions/results`;
export const CHAT_URL = `${API_BASE}/api/chat`;
export const CHAT_HISTORY_URL = `${API_BASE}/api/chat/history`;
export const CHAT_CLEAR_URL = `${API_BASE}/api/chat/clear`;
export const CHAT_SAVE_URL = `${API_BASE}/api/chat/save`;
export const CHAT_CONVERSATIONS_URL = `${API_BASE}/api/chat/conversations`;
export const DEVICE_REGISTER_URL = `${API_BASE}/api/devices/register`;
export const HIGHLIGHTS_URL = `${API_BASE}/api/highlights`;
export const INSIGHT_DISMISS_URL = `${API_BASE}/api/insights/dismiss`;
export const CONSOLIDATE_URL = `${API_BASE}/api/consolidate`;
export const SLEEP_TODAY_URL = `${API_BASE}/api/sleep/today`;
export const HABITS_STREAKS_URL = `${API_BASE}/api/habits/streaks`;
export const HABITS_TODAY_URL = `${API_BASE}/api/habits/today`;
export const HABITS_HISTORY_URL = `${API_BASE}/api/habits/history`;
export const EAT_HEALTHY_TODAY_URL = `${API_BASE}/api/habits/eat-healthy/today`;
export const EAT_HEALTHY_SCORE_URL = `${API_BASE}/api/habits/eat-healthy/score`;
export const GRATITUDE_TODAY_URL = `${API_BASE}/api/habits/gratitude/today`;
export const GRATITUDE_URL = `${API_BASE}/api/habits/gratitude`;
export const CONTEXT_URL = `${API_BASE}/api/context`;
export const CONTEXT_TODAY_URL = `${API_BASE}/api/context/today`;
export const CONTEXT_HISTORY_URL = `${API_BASE}/api/context/history`;
export const WORKOUT_LOG_URL = `${API_BASE}/api/workout/log`;
export const WORKOUT_PROGRESSION_URL = `${API_BASE}/api/workout/progression`;
export const WORKOUT_OVERRIDE_URL = `${API_BASE}/api/workout/override`;
export const WORKOUT_OVERRIDES_URL = `${API_BASE}/api/workout/overrides`;
export const ACTIVITY_URL = `${API_BASE}/api/activity`;
export const ANNOTATIONS_URL = `${API_BASE}/api/annotations`;
export const CHECKIN_HISTORY_URL = `${API_BASE}/api/checkin/history`;
export const BRIEFING_CONTEXT_URL = `${API_BASE}/api/briefing/context`;
export const BRIEFING_ACTION_COMMIT_URL = `${API_BASE}/api/briefing/action/commit`;
export const BRIEFING_ACTION_ALTERNATES_URL = `${API_BASE}/api/briefing/action/alternates`;
export const EXPERIMENTS_URL = `${API_BASE}/api/experiments`;
export const COMMITMENTS_URL = `${API_BASE}/api/commitments`;
export const WEALTH_PLAN_URL = `${API_BASE}/api/wealth/plan`;
export const RECOVERY_SELF_REPORT_URL = `${API_BASE}/api/recovery/self-report`;
export const GOALS_URL = `${API_BASE}/api/goals`;
export const METRICS_HISTORY_URL = `${API_BASE}/api/metrics/history`;
export const RECOVERY_HISTORY_URL = `${API_BASE}/api/recovery/history`;
export const SOURCES_FRESHNESS_URL = `${API_BASE}/api/sources/freshness`;

/** Device's IANA timezone — follows the phone when travelling. */
export function localTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
}

/** Today's date string (YYYY-MM-DD) in the device's local timezone. */
export function localDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: localTz() }).format(new Date());
}

/** JSON headers, plus the bearer token and the device timezone. */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-Time-Zone': localTz() };
  if (API_TOKEN) h.Authorization = `Bearer ${API_TOKEN}`;
  return h;
}

/**
 * fetch() with a hard timeout (default 20s) so a stalled request can't hang a
 * spinner forever — important since the app is meant to work off-WiFi/unplugged.
 * Throws on timeout (AbortError) just like a network failure, so callers' catch
 * blocks handle it uniformly.
 *
 * Both the timeout and any caller-supplied signal are respected: whichever fires
 * first aborts the request. Previously the caller's signal was silently overwritten
 * by the spread, breaking useBriefing's component-level abort controller.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 20000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Chain caller's signal so EITHER their abort OR our timeout cancels the request.
  const { signal: callerSignal, ...restOptions } = options as RequestInit & { signal?: AbortSignal };
  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...restOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
