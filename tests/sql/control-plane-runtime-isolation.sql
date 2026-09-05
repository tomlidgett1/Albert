\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  role_record record;
BEGIN
  FOR role_record IN
    SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
      FROM pg_catalog.pg_roles
     WHERE rolname IN (
       'albert_sync_control','albert_webhook_control','albert_transform_control',
       'albert_semantic_control','albert_anthropic_control','albert_deletion_control'
     )
  LOOP
    IF role_record.rolcanlogin OR role_record.rolsuper OR role_record.rolcreaterole
       OR role_record.rolcreatedb OR role_record.rolreplication OR role_record.rolbypassrls THEN
      RAISE EXCEPTION 'runtime group % has unsafe attributes', role_record.rolname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN (
    'albert_sync_control','albert_webhook_control','albert_transform_control',
    'albert_semantic_control','albert_anthropic_control','albert_deletion_control'
  )) <> 6 THEN
    RAISE EXCEPTION 'one or more constrained control roles are missing';
  END IF;
END;
$$;

DO $$
BEGIN
  IF has_schema_privilege('service_role','control_plane','USAGE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS object
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=object.relnamespace
       WHERE namespace.nspname='control_plane'
         AND (
           (
             object.relkind IN ('r','p','v','m','f')
             AND (
               has_table_privilege('service_role',object.oid,'SELECT')
               OR has_table_privilege('service_role',object.oid,'INSERT')
               OR has_table_privilege('service_role',object.oid,'UPDATE')
               OR has_table_privilege('service_role',object.oid,'DELETE')
               OR has_any_column_privilege('service_role',object.oid,'SELECT')
               OR has_any_column_privilege('service_role',object.oid,'INSERT')
               OR has_any_column_privilege('service_role',object.oid,'UPDATE')
               OR has_any_column_privilege('service_role',object.oid,'REFERENCES')
             )
           )
           OR (
             object.relkind='S'
             AND (
               has_sequence_privilege('service_role',object.oid,'USAGE')
               OR has_sequence_privilege('service_role',object.oid,'SELECT')
               OR has_sequence_privilege('service_role',object.oid,'UPDATE')
             )
           )
         )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
       WHERE namespace.nspname='control_plane'
         AND has_function_privilege('service_role',routine.oid,'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'service_role retained Albert private control privileges';
  END IF;

  IF NOT has_schema_privilege('albert_sync_control','control_plane','USAGE')
     OR NOT has_table_privilege('albert_sync_control','control_plane.connections','SELECT')
     OR has_table_privilege('albert_sync_control','control_plane.connections','INSERT')
     OR has_table_privilege('albert_sync_control','control_plane.connections','UPDATE')
     OR has_table_privilege('albert_sync_control','control_plane.connections','DELETE')
     OR NOT has_table_privilege('albert_sync_control','control_plane.oauth_secret_envelopes','SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_function_privilege('albert_sync_control','control_plane.claim_sync_jobs(text,text,integer,integer)','EXECUTE')
     OR NOT has_function_privilege('albert_sync_control','control_plane.acquire_sync_write_permit(text,text,bigint,text,text,text,bigint,text,integer,integer)','EXECUTE')
     OR NOT has_function_privilege('albert_sync_control','control_plane.assert_sync_write_permit_and_issue_capability(text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_sync_control','control_plane.finalize_oauth_connection_identity(text,text,uuid,text,text,text,text,jsonb,text)','EXECUTE')
     OR NOT has_function_privilege('albert_sync_control','control_plane.record_connection_auth_health(text,text,bigint,text,text,text,text,text,text,bigint,text,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'sync control role is missing required capabilities';
  END IF;
  IF has_table_privilege('albert_sync_control','control_plane.conversation_turns','SELECT')
     OR has_table_privilege('albert_sync_control','control_plane.catalogue_documents','SELECT')
     OR has_table_privilege('albert_sync_control','control_plane.deletion_proofs','SELECT')
     OR has_table_privilege('albert_sync_control','control_plane.deletion_requests','SELECT')
     OR has_table_privilege('albert_sync_control','control_plane.deletion_requests','INSERT')
     OR has_table_privilege('albert_sync_control','control_plane.deletion_requests','UPDATE')
     OR has_table_privilege('albert_sync_control','control_plane.deletion_requests','DELETE')
     OR has_function_privilege('albert_sync_control','control_plane.enqueue_deletion_request(text)','EXECUTE')
     OR has_function_privilege('albert_sync_control','control_plane.cancel_reconnectable_connection_deletion(text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'sync control role crossed an unrelated trust boundary';
  END IF;

  IF NOT has_function_privilege('albert_webhook_control','control_plane.resolve_attested_deputy_webhook_material(text,bigint,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.resolve_attested_xero_webhook_connections(text,bigint,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.reserve_attested_webhook_receipt(text,bigint,text,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.finalize_attested_deputy_webhook(text,bigint,text,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.assert_attested_webhook_gateway_ready(text,bigint,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.accept_attested_xero_webhook_inbox(text,bigint,text,text,text,bytea,bytea,bytea)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.claim_attested_xero_webhook_inbox(text,bigint,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.record_attested_xero_webhook_sequence(text,bigint,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.enqueue_attested_xero_webhook_incremental(text,bigint,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.enqueue_attested_xero_webhook_gap_sweeps(text,bigint,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'webhook control role is missing required capabilities';
  END IF;
  IF has_table_privilege('albert_webhook_control','control_plane.connections','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.webhook_receipts','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.webhook_receipts','INSERT')
     OR has_table_privilege('albert_webhook_control','control_plane.webhook_receipts','UPDATE')
     OR has_table_privilege('albert_webhook_control','control_plane.oauth_token_refs','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.oauth_secret_envelopes','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.oauth_session_secret_envelopes','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.sync_runs','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.raw_batch_manifests','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.xero_webhook_inbox','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.xero_webhook_sequence_state','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.webhook_attestation_keys','SELECT')
     OR has_function_privilege('albert_webhook_control','control_plane.resolve_deputy_webhook_material(text,text)','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.assert_deputy_webhook_gateway_ready(text[])','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.resolve_xero_webhook_connections(text[])','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.assert_webhook_attestation_ready(text)','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.accept_xero_webhook_inbox(text,text,text,bytea,bytea,bytea,integer,integer,integer,integer,timestamptz,timestamptz,timestamptz)','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.claim_xero_webhook_inbox(text,integer,integer)','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.xero_webhook_inbox_health()','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.assert_webhook_gateway_ready()','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.enqueue_deputy_webhook_sync(text,text,text,text,timestamptz)','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.enqueue_sync_job(jsonb,text,text,integer)','EXECUTE')
     OR has_function_privilege('albert_webhook_control','control_plane.assert_pgmq_ready()','EXECUTE') THEN
    RAISE EXCEPTION 'webhook control role crossed a credential or ingestion boundary';
  END IF;

  IF NOT has_function_privilege(
       'albert_transform_control',
       'control_plane.publish_transform_dossier(text,jsonb,jsonb,text)',
       'EXECUTE'
     )
     OR has_table_privilege('albert_transform_control','control_plane.dossiers','INSERT')
     OR has_table_privilege('albert_transform_control','control_plane.audit_log','INSERT') THEN
    RAISE EXCEPTION 'transform dossier publication is not fixed-function isolated';
  END IF;
  IF has_function_privilege(
       'albert_sync_control',
       'control_plane.publish_transform_dossier(text,jsonb,jsonb,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'albert_webhook_control',
       'control_plane.publish_transform_dossier(text,jsonb,jsonb,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'dossier publication crossed into another runtime role';
  END IF;

  IF pg_has_role('albert_webhook_control','albert_sync_control','MEMBER')
     OR pg_has_role('albert_sync_control','albert_semantic_control','MEMBER')
     OR pg_has_role('albert_anthropic_control','albert_semantic_control','MEMBER') THEN
    RAISE EXCEPTION 'constrained runtime groups are unexpectedly nested';
  END IF;
END;
$$;

SET LOCAL ROLE albert_webhook_control;
DO $$
BEGIN
  IF current_user <> 'albert_webhook_control' THEN
    RAISE EXCEPTION 'webhook role could not be assumed';
  END IF;
  BEGIN
    PERFORM 1 FROM control_plane.connections LIMIT 1;
    RAISE EXCEPTION 'webhook role read the connection table directly';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO control_plane.webhook_receipts(
      tenant_id,webhook_receipt_id,connection_id,connector_key,dedupe_key,
      body_sha256,signature_verified,safe_headers,status,received_at
    ) VALUES (
      '01H00000000000000000000001','01H00000000000000000000002',
      '01H00000000000000000000003','deputy','forged',repeat('0',64),true,
      '{}'::jsonb,'received',now()
    );
    RAISE EXCEPTION 'webhook role forged a verified receipt';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM control_plane.oauth_token_refs LIMIT 1;
    RAISE EXCEPTION 'webhook role read OAuth token references';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM control_plane.oauth_secret_envelopes LIMIT 1;
    RAISE EXCEPTION 'webhook role read an encrypted OAuth envelope';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM control_plane.xero_webhook_inbox LIMIT 1;
    RAISE EXCEPTION 'webhook role bypassed the fixed Xero inbox functions';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM control_plane.xero_webhook_inbox_health();
    RAISE EXCEPTION 'webhook role called the legacy Xero health function';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

ROLLBACK;
