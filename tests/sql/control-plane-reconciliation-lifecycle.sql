\set ON_ERROR_STOP on

-- Generation- and queue-lease-fenced reconciliation phase transitions.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'control reconciliation assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status)
VALUES ('01H00000000000000000000701','reconciliation-lifecycle','Reconciliation lifecycle','active');
INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,connection_generation
) VALUES (
  '01H00000000000000000000701','01H00000000000000000000702','xero',
  'Reconciliation Xero','xero-reconciliation','connected','healthy',1
);

INSERT INTO control_plane.sync_job_requests(
  tenant_id,job_request_id,connection_id,idempotency_key,job_type,priority,
  queue_name,queue_message_id,payload,status,last_claimed_at
) VALUES
  (
    '01H00000000000000000000701','01H00000000000000000000704',
    '01H00000000000000000000702','reconciliation:items:late:1',
    'ReconciliationSweep','standard','albert_sync_standard',77001,
    '{"schemaVersion":1,"type":"ReconciliationSweep","tenantId":"01H00000000000000000000701","connectionId":"01H00000000000000000000702","connectionGeneration":1,"connectorId":"xero","reconciliationSweepId":"01H00000000000000000000703","stream":"items","phase":"late_edits"}',
    'running',now()
  ),
  (
    '01H00000000000000000000701','01H00000000000000000000706',
    '01H00000000000000000000702','reconciliation:sales:late:1',
    'ReconciliationSweep','standard','albert_sync_standard',77002,
    '{"schemaVersion":1,"type":"ReconciliationSweep","tenantId":"01H00000000000000000000701","connectionId":"01H00000000000000000000702","connectionGeneration":1,"connectorId":"xero","reconciliationSweepId":"01H00000000000000000000703","stream":"sales","phase":"late_edits"}',
    'running',now()
  ),
  (
    '01H00000000000000000000701','01H00000000000000000000708',
    '01H00000000000000000000702','reconciliation:items:identity:1',
    'ReconciliationSweep','standard','albert_sync_standard',77003,
    '{"schemaVersion":1,"type":"ReconciliationSweep","tenantId":"01H00000000000000000000701","connectionId":"01H00000000000000000000702","connectionGeneration":1,"connectorId":"xero","reconciliationSweepId":"01H00000000000000000000703","stream":"items","phase":"identity_snapshot"}',
    'running',now()
  );

INSERT INTO control_plane.sync_job_attempts(
  tenant_id,job_attempt_id,job_request_id,attempt_number,worker_id,visibility_deadline
) VALUES
  ('01H00000000000000000000701','01H00000000000000000000705',
   '01H00000000000000000000704',1,'worker-reconciliation-a',now()+interval '10 minutes'),
  ('01H00000000000000000000701','01H00000000000000000000707',
   '01H00000000000000000000706',1,'worker-reconciliation-b',now()+interval '10 minutes'),
  ('01H00000000000000000000701','01H00000000000000000000709',
   '01H00000000000000000000708',1,'worker-reconciliation-c',now()+interval '10 minutes');

SET LOCAL ROLE albert_sync_control;

SELECT control_plane.register_reconciliation_stream(
  '01H00000000000000000000701','01H00000000000000000000702',1,
  '01H00000000000000000000703','xero','items',true,ARRAY['commerce'],
  'modified_field','authoritative_identity_scan','count_distinct_complete_scan',
  '2026-07-01T00:00:00Z','2026-08-03T00:00:00Z'
);
SELECT control_plane.register_reconciliation_stream(
  '01H00000000000000000000701','01H00000000000000000000702',1,
  '01H00000000000000000000703','xero','sales',true,ARRAY['commerce'],
  'modified_field','authoritative_identity_scan','count_distinct_complete_scan',
  '2026-07-01T00:00:00Z','2026-08-03T00:00:00Z'
);

SELECT pg_temp.assert_true(
  control_plane.begin_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','items','late_edits',
    '01H00000000000000000000704','albert_sync_standard',77001,
    'worker-reconciliation-a',1
  ),
  'the exact active queue lease must begin the planned phase'
);

DO $$
BEGIN
  PERFORM control_plane.complete_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','items','late_edits','{"batchId":"never-begun"}',
    '01H00000000000000000000708','albert_sync_standard',77003,
    'worker-reconciliation-c',1
  );
  RAISE EXCEPTION 'never-begun phase completion was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

SELECT pg_temp.assert_true(
  control_plane.complete_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','items','late_edits','{"batchId":"batch-a"}',
    '01H00000000000000000000704','albert_sync_standard',77001,
    'worker-reconciliation-a',1
  )='identity_snapshot',
  'completion must advance exactly one phase'
);
SELECT pg_temp.assert_true(
  control_plane.complete_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','items','late_edits','{"batchId":"batch-a"}',
    '01H00000000000000000000704','albert_sync_standard',77001,
    'worker-reconciliation-a',1
  )='identity_snapshot',
  'the exact completed lease/evidence replay must be idempotent'
);

DO $$
BEGIN
  PERFORM control_plane.complete_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','items','late_edits','{"batchId":"changed"}',
    '01H00000000000000000000704','albert_sync_standard',77001,
    'worker-reconciliation-a',1
  );
  RAISE EXCEPTION 'changed completion replay was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.begin_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','items','identity_snapshot',
    '01H00000000000000000000708','albert_sync_standard',77003,
    'wrong-worker',1
  );
  RAISE EXCEPTION 'wrong worker lease was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

SELECT pg_temp.assert_true(
  control_plane.begin_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','sales','late_edits',
    '01H00000000000000000000706','albert_sync_standard',77002,
    'worker-reconciliation-b',1
  ),
  'second stream must begin under its own exact job lease'
);
SELECT control_plane.block_reconciliation_phase(
  '01H00000000000000000000701','01H00000000000000000000702',1,
  '01H00000000000000000000703','sales','late_edits',
  '{"code":"reconciliation_snapshot_failed","retryable":false}',
  '01H00000000000000000000706','albert_sync_standard',77002,
  'worker-reconciliation-b',1
);
SELECT control_plane.block_reconciliation_phase(
  '01H00000000000000000000701','01H00000000000000000000702',1,
  '01H00000000000000000000703','sales','late_edits',
  '{"code":"reconciliation_snapshot_failed","retryable":false}',
  '01H00000000000000000000706','albert_sync_standard',77002,
  'worker-reconciliation-b',1
);
DO $$
BEGIN
  PERFORM control_plane.block_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','sales','late_edits',
    '{"code":"unexpected_sync_failure","retryable":false}',
    '01H00000000000000000000706','albert_sync_standard',77002,
    'worker-reconciliation-b',1
  );
  RAISE EXCEPTION 'changed blocked replay was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;
DO $$
BEGIN
  PERFORM control_plane.begin_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','sales','late_edits',
    '01H00000000000000000000706','albert_sync_standard',77002,
    'worker-reconciliation-b',1
  );
  RAISE EXCEPTION 'blocked phase was restarted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

RESET ROLE;
UPDATE control_plane.connections
   SET connection_generation=2
 WHERE tenant_id='01H00000000000000000000701'
   AND connection_id='01H00000000000000000000702';
SET LOCAL ROLE albert_sync_control;
DO $$
BEGIN
  PERFORM control_plane.begin_reconciliation_phase(
    '01H00000000000000000000701','01H00000000000000000000702',1,
    '01H00000000000000000000703','items','identity_snapshot',
    '01H00000000000000000000708','albert_sync_standard',77003,
    'worker-reconciliation-c',1
  );
  RAISE EXCEPTION 'stale connection generation was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

RESET ROLE;
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'service_role','control_plane.reconciliation_stream_sweeps','SELECT,INSERT,UPDATE,DELETE'
  ),
  'service_role must have no reconciliation plan table privileges'
);
SELECT pg_temp.assert_true(
  has_table_privilege(
    'albert_sync_control','control_plane.reconciliation_stream_sweeps','SELECT'
  ) AND NOT has_table_privilege(
    'albert_sync_control','control_plane.reconciliation_stream_sweeps','INSERT,UPDATE,DELETE'
  ),
  'sync runtime must have read-only table access and use narrow functions for mutation'
);
SELECT pg_temp.assert_true(
  (SELECT phase_transition_leases->'late_edits'=
    '{"jobRequestId":"01H00000000000000000000704","queueName":"albert_sync_standard","messageId":77001,"workerId":"worker-reconciliation-a","readCount":1}'::jsonb
     FROM control_plane.reconciliation_stream_sweeps
    WHERE tenant_id='01H00000000000000000000701'
      AND connection_id='01H00000000000000000000702'
      AND reconciliation_sweep_id='01H00000000000000000000703'
      AND stream='items'),
  'completed transition must retain the exact immutable lease identity'
);
SELECT pg_temp.assert_true(
  (SELECT status='blocked'
          AND phase_transition_leases->'late_edits'->>'workerId'='worker-reconciliation-b'
     FROM control_plane.reconciliation_stream_sweeps
    WHERE tenant_id='01H00000000000000000000701'
      AND connection_id='01H00000000000000000000702'
      AND reconciliation_sweep_id='01H00000000000000000000703'
      AND stream='sales'),
  'blocked transition must retain failure evidence and the exact lease identity'
);

ROLLBACK;
