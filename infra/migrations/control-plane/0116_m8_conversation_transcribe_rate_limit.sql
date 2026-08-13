BEGIN;

-- Dictation uploads to OpenAI gpt-transcribe. Keep this separate from turn
-- submission so voice input cannot starve chat sends (and vice versa).

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('conversation.transcribe', 30, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

COMMIT;
