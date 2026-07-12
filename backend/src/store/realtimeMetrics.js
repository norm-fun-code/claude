// Latency/usage ledger for Talk to NormOS (the Realtime voice mode) — see
// migrations/044_realtime_voice.sql. NEVER stores raw audio, only timing and
// small metadata the mobile client reports about its own WebRTC session
// (connect time, speech-end-to-first-audio latency, tool-call duration,
// whether a barge-in interruption succeeded, errors/reconnects, and whether a
// turn resolved on the Realtime fast path or fell through to deep_ask).
const { query } = require('../db');

/** Best-effort — a metrics-ledger hiccup must never break the caller's own
 *  request/response flow (the mobile client posts these fire-and-forget). */
async function logEvent({ sessionId, type, valueMs = null, meta = {} }) {
  if (!sessionId || !type) return null;
  try {
    const { rows } = await query(
      `INSERT INTO voice_realtime_events (session_id, event_type, value_ms, meta)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [String(sessionId), String(type), Number.isFinite(Number(valueMs)) ? Math.round(Number(valueMs)) : null, JSON.stringify(meta || {})]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('[realtime metrics] log failed:', err.message);
    return null;
  }
}

/** Rough p50/p90 + counts per event type over the trailing window — for a
 *  debug/health view, not user-facing. Fail-safe: [] on error. */
async function recentSummary({ days = 7 } = {}) {
  try {
    const { rows } = await query(
      `SELECT event_type,
              count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY value_ms) AS p50_ms,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY value_ms) AS p90_ms
         FROM voice_realtime_events
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY event_type
        ORDER BY event_type`,
      [String(days)]
    );
    return rows;
  } catch {
    return [];
  }
}

module.exports = { logEvent, recentSummary };
