\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'protected-dogfood seed assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '54000000-0000-4000-8000-000000000054','authenticated','authenticated',
  'dogfood-gate-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

INSERT INTO control_plane.tenants(
  tenant_id,slug,display_name,status,created_by,created_at,updated_at
) VALUES (
  '01H00000000000000000005401','protected-dogfood-gate-fixture',
  'Protected dogfood gate fixture','active',
  '54000000-0000-4000-8000-000000000054',clock_timestamp(),clock_timestamp()
);

INSERT INTO control_plane.memberships(
  tenant_id,membership_id,user_id,role,status,created_by
) VALUES (
  '01H00000000000000000005401','01H00000000000000000005402',
  '54000000-0000-4000-8000-000000000054','owner','active',
  '54000000-0000-4000-8000-000000000054'
);

SELECT pg_temp.assert_true(
  (SELECT count(*)=3
     FROM control_plane.protected_dogfood_runtime_observations
    WHERE candidate_sha='dddddddddddddddddddddddddddddddddddddddd'
      AND deployment_id='ci-dogfood-deployment-1'),
  'each exact worker runtime login must establish one durable observation'
);

SELECT pg_temp.assert_true(
  control_plane.protected_dogfood_deployment_barrier(
    'dddddddddddddddddddddddddddddddddddddddd','ci-dogfood-deployment-1'
  ) BETWEEN clock_timestamp()-interval '20 seconds' AND clock_timestamp(),
  'the barrier must be derived from all three fresh candidate worker heartbeats'
);

DO $$
BEGIN
  PERFORM control_plane.protected_dogfood_deployment_barrier(
    'dddddddddddddddddddddddddddddddddddddddd','ci-missing-deployment'
  );
  RAISE EXCEPTION 'a missing runtime set passed the deployment barrier';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.protected_dogfood_deployment_barrier(
    'dddddddddddddddddddddddddddddddddddddddd','ci-forged-deployment'
  );
  RAISE EXCEPTION 'one runtime credential forged the three-worker barrier';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

WITH evidence(value) AS (VALUES (
  '{
    "schemaVersion":1,
    "capturedAt":"2026-08-03T00:00:00+00:00",
    "candidateSha":"dddddddddddddddddddddddddddddddddddddddd",
    "deployment":{
      "deploymentId":"ci-dogfood-deployment-1",
      "barrierAt":"2026-08-03T00:00:00+00:00",
      "candidateWorkerCount":3
    },
    "connections":[],
    "milestones":{},
    "references":{}
  }'::jsonb
))
INSERT INTO control_plane.protected_dogfood_acceptance_snapshots(
  snapshot_id,candidate_sha,evidence,evidence_digest,captured_at
)
SELECT
  '01H00000000000000000005403',
  'dddddddddddddddddddddddddddddddddddddddd',
  value,control_plane.dogfood_evidence_sha256(value),clock_timestamp()
FROM evidence;

COMMIT;
