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
       'albert_semantic_control','albert_deletion_control'
     )
  LOOP
    IF role_record.rolcanlogin OR role_record.rolsuper OR role_record.rolcreaterole
       OR role_record.rolcreatedb OR role_record.rolreplication OR role_record.rolbypassrls THEN
      RAISE EXCEPTION 'runtime group % has unsafe attributes', role_record.rolname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN (
    'albert_sync_control','albert_webhook_control','albert_transform_control',
    'albert_semantic_control','albert_deletion_control'
  )) <> 5 THEN
    RAISE EXCEPTION 'one or more constrained control roles are missing';
  END IF;
END;
$$;

DO $$
BEGIN
  IF has_schema_privilege('service_role','control_plane','USAGE')
     OR has_table_privilege('service_role','control_plane.connections','SELECT')
     OR has_function_privilege('service_role','control_plane.enqueue_sync_job(jsonb,text,text,integer)','EXECUTE')
     OR has_function_privilege('service_role','control_plane.publish_transform_dossier(text,jsonb,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'service_role retained Albert private control privileges';
  END IF;

  IF NOT has_schema_privilege('albert_sync_control','control_plane','USAGE')
     OR NOT has_table_privilege('albert_sync_control','control_plane.connections','SELECT,INSERT,UPDATE')
     OR NOT has_table_privilege('albert_sync_control','control_plane.oauth_secret_envelopes','SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_function_privilege('albert_sync_control','control_plane.claim_sync_jobs(text,text,integer,integer)','EXECUTE')
     OR NOT has_function_privilege('albert_sync_control','control_plane.acquire_sync_write_permit(text,text,text,text,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'sync control role is missing required capabilities';
  END IF;
  IF has_table_privilege('albert_sync_control','control_plane.conversation_turns','SELECT')
     OR has_table_privilege('albert_sync_control','control_plane.catalogue_documents','SELECT')
     OR has_table_privilege('albert_sync_control','control_plane.deletion_proofs','SELECT') THEN
    RAISE EXCEPTION 'sync control role crossed an unrelated trust boundary';
  END IF;

  IF NOT has_table_privilege('albert_webhook_control','control_plane.connections','SELECT')
     OR NOT has_table_privilege('albert_webhook_control','control_plane.webhook_receipts','SELECT,INSERT,UPDATE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.resolve_deputy_webhook_material(text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.assert_deputy_webhook_gateway_ready(text[])','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.enqueue_deputy_webhook_sync(text,text,text,text,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.accept_xero_webhook_inbox(text,text,text,bytea,bytea,bytea,integer,integer,integer,integer,timestamptz,timestamptz,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.claim_xero_webhook_inbox(text,integer,integer)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.record_xero_webhook_sequence(text,text)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.enqueue_xero_webhook_incremental(text,text,text,text,text,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.enqueue_xero_webhook_gap_sweeps(text,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('albert_webhook_control','control_plane.assert_webhook_gateway_ready()','EXECUTE') THEN
    RAISE EXCEPTION 'webhook control role is missing required capabilities';
  END IF;
  IF has_table_privilege('albert_webhook_control','control_plane.oauth_token_refs','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.oauth_secret_envelopes','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.oauth_session_secret_envelopes','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.sync_runs','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.raw_batch_manifests','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.xero_webhook_inbox','SELECT')
     OR has_table_privilege('albert_webhook_control','control_plane.xero_webhook_sequence_state','SELECT')
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
     OR pg_has_role('albert_sync_control','albert_semantic_control','MEMBER') THEN
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
  PERFORM 1 FROM control_plane.connections LIMIT 1;
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
  PERFORM * FROM control_plane.xero_webhook_inbox_health();
END;
$$;
RESET ROLE;

ROLLBACK;
