-- Talk to NormOS: OpenAI Realtime voice sessions. No raw audio is ever
-- stored here — only latency/usage events for the metrics the product spec
-- asked to track (connect time, first-audio latency, tool-call duration,
-- interruption success, errors/reconnects, fast-path vs deep_ask usage).
CREATE TABLE IF NOT EXISTS voice_realtime_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'connect' | 'first_audio' | 'tool_call' | 'interruption' | 'error' | 'reconnect' | 'deep_ask' | 'fast_path'
  value_ms INTEGER,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_realtime_events_session ON voice_realtime_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_realtime_events_type ON voice_realtime_events (event_type, created_at);
