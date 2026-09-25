-- 0162: rate-limit policy for realtime voice sessions (ADR 0116).
--
-- /api/voice-session mints a ~10-minute OpenAI Realtime client secret.
-- consume_albert_rate_limit() refuses unknown actions, and the numbers must
-- match ALBERT_RATE_LIMIT_POLICIES in services/control-plane/src/web-repository.ts.
BEGIN;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('conversation.voice_session', 10, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

COMMIT;
