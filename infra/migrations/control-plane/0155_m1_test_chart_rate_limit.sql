-- 0155: rate-limit policy for the Test chart playground.
--
-- /api/test-chart invents a series and posts it to the AntV MCP vis service.
-- consume_albert_rate_limit() refuses unknown actions, and the numbers must
-- match ALBERT_RATE_LIMIT_POLICIES in services/control-plane/src/web-repository.ts.
BEGIN;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('test-chart.generate', 20, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

COMMIT;
