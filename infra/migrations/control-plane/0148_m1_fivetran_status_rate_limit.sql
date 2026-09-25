-- 0148: rate-limit policy for the live Fivetran Xero sync readout.
--
-- The Connections card polls /api/connections/fivetran-status while a
-- Fivetran load is running. Each poll fans out to Fivetran's API and to a
-- catalog read on the analytical database, so it is metered like any other
-- authenticated action. consume_albert_rate_limit() refuses unknown actions,
-- and the numbers must match ALBERT_RATE_LIMIT_POLICIES in
-- services/control-plane/src/web-repository.ts.
BEGIN;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('connection.fivetran_status', 30, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

COMMIT;
