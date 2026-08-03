\set ON_ERROR_STOP on

BEGIN;

SELECT 1/CASE WHEN session_user=:'dogfood_login' THEN 1 ELSE 0 END;

SET LOCAL ROLE :"dogfood_group";

SELECT control_plane.heartbeat_worker(
  :'dogfood_worker_id',
  'dddddddddddddddddddddddddddddddddddddddd',
  'ci-dogfood-deployment-1',
  clock_timestamp()-interval '10 seconds',
  0,
  jsonb_build_object('service',:'dogfood_service','ready',true)
);

COMMIT;
