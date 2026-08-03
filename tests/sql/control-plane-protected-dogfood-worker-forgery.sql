\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF session_user<>'albert_sync_control_runtime' THEN
    RAISE EXCEPTION 'worker forgery proof requires the exact sync runtime login';
  END IF;
END;
$$;

SET LOCAL ROLE albert_sync_control;

-- A compromised sync credential can write heartbeat metadata, but it cannot
-- establish the transform or deletion first-observation facts.
SELECT control_plane.heartbeat_worker(
  'ci-forged-sync','dddddddddddddddddddddddddddddddddddddddd',
  'ci-forged-deployment',clock_timestamp()-interval '10 seconds',0,
  '{"service":"sync-worker","ready":true}'::jsonb
);
SELECT control_plane.heartbeat_worker(
  'ci-forged-transform','dddddddddddddddddddddddddddddddddddddddd',
  'ci-forged-deployment',clock_timestamp()-interval '10 seconds',0,
  '{"service":"transform-worker","ready":true}'::jsonb
);
SELECT control_plane.heartbeat_worker(
  'ci-forged-deletion','dddddddddddddddddddddddddddddddddddddddd',
  'ci-forged-deployment',clock_timestamp()-interval '10 seconds',0,
  '{"service":"deletion-worker","ready":true}'::jsonb
);

COMMIT;
