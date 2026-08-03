\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'protected-dogfood verification failed: %',message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.protected_dogfood_acceptance_consumptions
    WHERE snapshot_id='01H00000000000000000005403'),
  'the snapshot must have exactly one durable release consumption'
);

SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND bool_and(succeeded)
     FROM control_plane.protected_dogfood_semantic_turn_results result
     JOIN control_plane.protected_dogfood_semantic_turn_leases lease USING(lease_id)
    WHERE lease.workflow_run_id='540000000000000054'
      AND lease.workflow_run_attempt=1
      AND lease.case_id='numeric_golden' AND lease.pass=1),
  'the semantic case/pass must have one successful immutable result'
);

SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND bool_and(turn_record.status='failed')
     FROM control_plane.protected_dogfood_semantic_turn_leases lease
     JOIN control_plane.conversation_turns turn_record
       ON turn_record.tenant_id=lease.tenant_id AND turn_record.turn_id=lease.turn_id
    WHERE lease.workflow_run_id='540000000000000054'
      AND lease.workflow_run_attempt=1),
  'the real diagnostic conversation turn must be terminal after the probe'
);

SELECT pg_temp.assert_true(
  NOT pg_catalog.has_table_privilege(
    'albert_operator_diagnostic_control_runtime',
    'control_plane.protected_dogfood_acceptance_snapshots','SELECT'
  ) AND NOT pg_catalog.has_table_privilege(
    'albert_operator_diagnostic_control_runtime',
    'control_plane.protected_dogfood_semantic_turn_leases','SELECT'
  ),
  'the diagnostic login must not receive direct evidence-ledger reads'
);

CREATE OR REPLACE FUNCTION pg_temp.measured_zero_deletion_stores()
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'credential_vault',jsonb_build_object(
      'verified',true,'tokenReferences',0,'credentialEnvelopes',0,'sessionEnvelopes',0
    ),
    'raw_storage',jsonb_build_object('verified',true,'remainingObjects',0),
    'analytical',jsonb_build_object(
      'verified',true,
      'scope','tenant',
      'measurement','post_purge_row_counts_v1',
      'remainingRows',0,
      'residuals',jsonb_build_object(
        'stagingRows',0,'canonicalRows',0,'bridgeRows',0,'linkRows',0,
        'embeddingRows',0,'cacheRows',0,'otherAnalyticalRows',0
      )
    ),
    'control_plane',jsonb_build_object(
      'verified',true,
      'remainingTenantOrConnectionRows',0,
      'remainingDerivedArtifacts',0,
      'remainingQueueMessages',0
    )
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.privacy_safe_remote_revocation()
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'attemptedAt','2026-08-04T00:00:00.000Z',
    'priorStatus','pending',
    'targetCount',0,
    'targets','[]'::jsonb,
    'bestEffort',true
  );
$$;

SELECT pg_temp.assert_true(
  control_plane.dogfood_deletion_residuals(
    pg_temp.measured_zero_deletion_stores()
  )->>'otherAnalyticalRows'='0',
  'a complete measured zero-residual proof must pass'
);

SELECT pg_temp.assert_true(
  control_plane.require_privacy_safe_remote_revocation(
    pg_temp.privacy_safe_remote_revocation()
  ),
  'the exact bounded remote revocation proof must pass'
);

SELECT pg_temp.assert_true(
  control_plane.require_privacy_safe_remote_revocation(
    jsonb_build_object(
      'attemptedAt','2026-08-04T00:00:00.000Z',
      'priorStatus','failed','targetCount',0,'targets','[]'::jsonb,
      'bestEffort',true,'forcedLocalDestruction',true,
      'reason','remote_revocation_grace_expired'
    )
  ),
  'watchdog destruction must use its exact privacy-safe evidence variant'
);

SELECT pg_temp.assert_true(
  control_plane.require_privacy_safe_deletion_stores(
    pg_temp.measured_zero_deletion_stores(),'tenant'
  ),
  'the exact zero-count cross-store proof must pass'
);

SELECT pg_temp.assert_true(
  control_plane.require_privacy_safe_deletion_progress(
    'raw_storage','{"verified":true,"objectsRemoved":7}'::jsonb,'tenant'
  ) AND control_plane.require_privacy_safe_deletion_progress(
    'analytical','{"verified":true,"scope":"tenant","rowsRemoved":9}'::jsonb,'tenant'
  ) AND control_plane.require_privacy_safe_deletion_progress(
    'control_plane','{"verified":true,"scope":"tenant","rowsRemoved":4}'::jsonb,'tenant'
  ) AND control_plane.require_privacy_safe_deletion_progress(
    'verification','{"verified":true,"storesVerified":4}'::jsonb,'tenant'
  ),
  'only bounded count summaries must be accepted as deletion progress'
);

SELECT pg_temp.assert_true(
  control_plane.require_measured_analytical_deletion(
    jsonb_set(
      pg_temp.measured_zero_deletion_stores()->'analytical',
      '{scope}','"connection"'::jsonb
    ),
    'connection'
  )=0,
  'the measured validator must accept the exact connection proof scope'
);

DO $$
BEGIN
  PERFORM control_plane.require_measured_analytical_deletion(
    pg_temp.measured_zero_deletion_stores()->'analytical','connection'
  );
  RAISE EXCEPTION 'a tenant attestation was accepted as a connection proof';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
DECLARE analytical jsonb;
BEGIN
  analytical:=pg_temp.measured_zero_deletion_stores()->'analytical'
    || jsonb_build_object('detail','customer@example.com');
  PERFORM control_plane.require_measured_analytical_deletion(analytical,'tenant');
  RAISE EXCEPTION 'free text entered a measured analytical proof';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
DECLARE remote_revocation jsonb;
BEGIN
  remote_revocation:=pg_temp.privacy_safe_remote_revocation()
    || jsonb_build_object('detail','customer@example.com');
  PERFORM control_plane.require_privacy_safe_remote_revocation(remote_revocation);
  RAISE EXCEPTION 'free text entered a remote revocation proof';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
DECLARE stores jsonb;
BEGIN
  stores:=jsonb_set(
    pg_temp.measured_zero_deletion_stores(),
    '{raw_storage}',
    (pg_temp.measured_zero_deletion_stores()->'raw_storage')
      || jsonb_build_object('detail','customer@example.com')
  );
  PERFORM control_plane.require_privacy_safe_deletion_stores(stores,'tenant');
  RAISE EXCEPTION 'free text entered a store verification proof';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.require_privacy_safe_deletion_progress(
    'raw_storage',
    '{"verified":true,"objectsRemoved":0,"prefix":"customer@example.com"}'::jsonb,
    'tenant'
  );
  RAISE EXCEPTION 'free text entered durable deletion progress';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.require_privacy_safe_deletion_progress(
    'verification',
    '{"verified":true,"storesVerified":4,"verifiedAt":"customer@example.com"}'::jsonb,
    'tenant'
  );
  RAISE EXCEPTION 'free text entered verification progress';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
DECLARE stores jsonb;
BEGIN
  stores:=jsonb_set(
    pg_temp.measured_zero_deletion_stores(),'{analytical,remainingRows}','1'::jsonb
  );
  PERFORM control_plane.dogfood_deletion_residuals(stores);
  RAISE EXCEPTION 'an inconsistent analytical residual total passed dogfood acceptance';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
DECLARE stores jsonb;
BEGIN
  stores:=pg_temp.measured_zero_deletion_stores()
    #- '{analytical,measurement}'::text[];
  PERFORM control_plane.dogfood_deletion_residuals(stores);
  RAISE EXCEPTION 'an unmeasured analytical residual object passed dogfood acceptance';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

COMMIT;
