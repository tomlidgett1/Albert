-- Shopify pack 1.0 is a production ingesting connector. Its typed source
-- schema and deletion closure were provisioned earlier, but the shared
-- reconciliation, quality, immutable canonical-staging and pack-release
-- boundaries still admit only the predecessor connector set. Widen those
-- boundaries atomically for this exact pack without changing any runtime ACL,
-- function owner, SECURITY DEFINER attribute, search_path, or RLS posture.

BEGIN;

CREATE TEMP TABLE _shopify_admission_relation_security_guard
ON COMMIT DROP
AS
SELECT class.oid AS relation_oid,class.relowner,class.relacl,
       class.relrowsecurity,class.relforcerowsecurity
  FROM pg_class class
  JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
  JOIN (VALUES
    ('quality','connector_check_observation'),
    ('quality','connector_stream_state'),
    ('quality','reconciliation_snapshot'),
    ('ingestion','canonical_staging_batch_records'),
    ('semantic_internal','canonical_transform_commits'),
    ('semantic_internal','connector_pack_release')
  ) target(schema_name,relation_name)
    ON target.schema_name=namespace.nspname
   AND target.relation_name=class.relname
 WHERE class.relkind IN ('r','p');

DO $$
DECLARE target record;
DECLARE constraint_definition text;
DECLARE observed_connector_ids text[];
DECLARE predecessor_connector_ids constant text[]:=
  ARRAY['deputy','lightspeed-r','momence','square','xero'];
BEGIN
  IF (SELECT count(*) FROM _shopify_admission_relation_security_guard)<>6 THEN
    RAISE EXCEPTION 'Shopify admission could not resolve all six guarded runtime relations'
      USING ERRCODE='55000';
  END IF;

  -- Refuse to replace a constraint from an unexpected predecessor state. This
  -- prevents an out-of-order deploy from silently removing a newer connector.
  FOR target IN
    SELECT * FROM (VALUES
      ('quality','connector_check_observation','connector_check_observation_connector_id_check'),
      ('quality','connector_stream_state','connector_stream_state_connector_id_check'),
      ('quality','reconciliation_snapshot','reconciliation_snapshot_connector_id_check'),
      ('ingestion','canonical_staging_batch_records','canonical_staging_batch_records_connector_id_check'),
      ('semantic_internal','canonical_transform_commits','canonical_transform_commits_connector_id_check'),
      ('semantic_internal','connector_pack_release','connector_pack_release_connector_id_check')
    ) value(schema_name,relation_name,constraint_name)
  LOOP
    SELECT pg_get_constraintdef(constraint_value.oid)
      INTO constraint_definition
      FROM pg_constraint constraint_value
      JOIN pg_class class ON class.oid=constraint_value.conrelid
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
     WHERE namespace.nspname=target.schema_name
       AND class.relname=target.relation_name
       AND constraint_value.conname=target.constraint_name
       AND constraint_value.contype='c';
    IF constraint_definition IS NULL THEN
      RAISE EXCEPTION 'Shopify admission predecessor constraint %.%/% is missing',
        target.schema_name,target.relation_name,target.constraint_name
        USING ERRCODE='55000';
    END IF;
    SELECT array_agg(capture.value[1] ORDER BY capture.value[1])
      INTO observed_connector_ids
      FROM regexp_matches(constraint_definition,'''([^'']+)''','g') capture(value);
    IF observed_connector_ids IS DISTINCT FROM predecessor_connector_ids THEN
      RAISE EXCEPTION 'Shopify admission predecessor connector vocabulary changed for %.%: %',
        target.schema_name,target.relation_name,observed_connector_ids
        USING ERRCODE='55000';
    END IF;
  END LOOP;
END
$$;

ALTER TABLE quality.connector_check_observation
  DROP CONSTRAINT connector_check_observation_connector_id_check;
ALTER TABLE quality.connector_check_observation
  ADD CONSTRAINT connector_check_observation_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square','shopify'));

ALTER TABLE quality.connector_stream_state
  DROP CONSTRAINT connector_stream_state_connector_id_check;
ALTER TABLE quality.connector_stream_state
  ADD CONSTRAINT connector_stream_state_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square','shopify'));

ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT reconciliation_snapshot_connector_id_check;
ALTER TABLE quality.reconciliation_snapshot
  ADD CONSTRAINT reconciliation_snapshot_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square','shopify'));

ALTER TABLE ingestion.canonical_staging_batch_records
  DROP CONSTRAINT canonical_staging_batch_records_connector_id_check;
ALTER TABLE ingestion.canonical_staging_batch_records
  ADD CONSTRAINT canonical_staging_batch_records_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square','shopify'));

ALTER TABLE semantic_internal.canonical_transform_commits
  DROP CONSTRAINT canonical_transform_commits_connector_id_check;
ALTER TABLE semantic_internal.canonical_transform_commits
  ADD CONSTRAINT canonical_transform_commits_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square','shopify'));

ALTER TABLE semantic_internal.connector_pack_release
  DROP CONSTRAINT connector_pack_release_connector_id_check;
ALTER TABLE semantic_internal.connector_pack_release
  ADD CONSTRAINT connector_pack_release_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square','shopify'));

INSERT INTO semantic_internal.connector_pack_release (
  connector_id,pack_version,release_sequence,predecessor_version,state,
  registered_by_migration,activated_at
) VALUES (
  'shopify','1.0.0',1,NULL,'active',
  '0154_m3_shopify_production_admission.sql',now()
)
ON CONFLICT (connector_id,pack_version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM semantic_internal.connector_pack_release release
     WHERE release.connector_id='shopify'
       AND release.pack_version='1.0.0'
       AND release.release_sequence=1
       AND release.predecessor_version IS NULL
       AND release.state='active'
       AND release.registered_by_migration='0154_m3_shopify_production_admission.sql'
       AND release.activated_at IS NOT NULL
  ) OR (
    SELECT count(*)
      FROM semantic_internal.connector_pack_release release
     WHERE release.connector_id='shopify' AND release.state='active'
  )<>1 THEN
    RAISE EXCEPTION 'Shopify connector pack 1.0.0 conflicts with durable release authority'
      USING ERRCODE='55000';
  END IF;
END
$$;

CREATE TEMP TABLE _shopify_admission_function_security_guard
ON COMMIT DROP
AS
SELECT procedure.oid AS procedure_oid,namespace.nspname AS schema_name,
       procedure.proname AS procedure_name,procedure.proowner,procedure.proacl,
       procedure.prosecdef,procedure.proleakproof,procedure.proisstrict,
       procedure.provolatile,procedure.proparallel,procedure.proconfig,
       procedure.prokind
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
  JOIN (VALUES
    ('quality.register_connector_streams(text,text,bigint,text,jsonb)'::regprocedure),
    ('quality.record_reconciliation_snapshot_page(text,text,bigint,text,text,text,integer,text,text,text,jsonb,bigint,bigint,boolean,bigint)'::regprocedure),
    ('quality.publish_connector_quality_results(text,text,text,text,text,text,jsonb)'::regprocedure),
    ('semantic_internal.publish_connector_capability_observations(text,text,text,text,text,timestamp with time zone,jsonb)'::regprocedure)
  ) target(procedure_oid) ON target.procedure_oid=procedure.oid
 WHERE procedure.prokind='f'
   AND pg_get_functiondef(procedure.oid) LIKE
       '%p_connector_id NOT IN (''lightspeed-r'',''xero'',''deputy'',''momence'',''square'')%';

DO $$
DECLARE function_row record;
DECLARE original_definition text;
DECLARE patched_definition text;
DECLARE patched_count integer:=0;
BEGIN
  IF (SELECT count(*) FROM _shopify_admission_function_security_guard)<>4 THEN
    RAISE EXCEPTION 'Shopify connector admission expected exactly four predecessor function guards'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT required.procedure_name
      FROM unnest(ARRAY[
        'register_connector_streams',
        'record_reconciliation_snapshot_page',
        'publish_connector_quality_results',
        'publish_connector_capability_observations'
      ]) required(procedure_name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM _shopify_admission_function_security_guard guarded
        WHERE guarded.procedure_name=required.procedure_name
     )
  ) THEN
    RAISE EXCEPTION 'A required Shopify production runtime function lacks the exact predecessor guard'
      USING ERRCODE='55000';
  END IF;

  -- pg_get_functiondef plus CREATE OR REPLACE changes only the closed connector
  -- vocabulary. The OID, owner, ACL, SECURITY DEFINER bit and SET configuration
  -- are captured above and asserted unchanged below, including on Supabase-hosted
  -- analytical databases.
  FOR function_row IN
    SELECT guarded.procedure_oid
      FROM _shopify_admission_function_security_guard guarded
     ORDER BY guarded.schema_name,guarded.procedure_name,guarded.procedure_oid
  LOOP
    original_definition:=pg_get_functiondef(function_row.procedure_oid);
    patched_definition:=replace(
      original_definition,
      'p_connector_id NOT IN (''lightspeed-r'',''xero'',''deputy'',''momence'',''square'')',
      'p_connector_id NOT IN (''lightspeed-r'',''xero'',''deputy'',''momence'',''square'',''shopify'')'
    );
    IF patched_definition=original_definition THEN
      RAISE EXCEPTION 'Shopify connector function admission made no change for %',
        function_row.procedure_oid::regprocedure
        USING ERRCODE='55000';
    END IF;
    EXECUTE patched_definition;
    patched_count:=patched_count+1;
  END LOOP;

  IF patched_count<>4 THEN
    RAISE EXCEPTION 'Shopify connector admission patched an incomplete function set: %',patched_count
      USING ERRCODE='55000';
  END IF;
END
$$;

DO $$
DECLARE target record;
DECLARE constraint_definition text;
DECLARE observed_connector_ids text[];
DECLARE admitted_connector_ids constant text[]:=
  ARRAY['deputy','lightspeed-r','momence','shopify','square','xero'];
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('quality','connector_check_observation','connector_check_observation_connector_id_check'),
      ('quality','connector_stream_state','connector_stream_state_connector_id_check'),
      ('quality','reconciliation_snapshot','reconciliation_snapshot_connector_id_check'),
      ('ingestion','canonical_staging_batch_records','canonical_staging_batch_records_connector_id_check'),
      ('semantic_internal','canonical_transform_commits','canonical_transform_commits_connector_id_check'),
      ('semantic_internal','connector_pack_release','connector_pack_release_connector_id_check')
    ) value(schema_name,relation_name,constraint_name)
  LOOP
    SELECT pg_get_constraintdef(constraint_value.oid)
      INTO constraint_definition
      FROM pg_constraint constraint_value
      JOIN pg_class class ON class.oid=constraint_value.conrelid
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
     WHERE namespace.nspname=target.schema_name
       AND class.relname=target.relation_name
       AND constraint_value.conname=target.constraint_name
       AND constraint_value.contype='c';
    SELECT array_agg(capture.value[1] ORDER BY capture.value[1])
      INTO observed_connector_ids
      FROM regexp_matches(coalesce(constraint_definition,''),'''([^'']+)''','g') capture(value);
    IF observed_connector_ids IS DISTINCT FROM admitted_connector_ids THEN
      RAISE EXCEPTION 'Shopify connector vocabulary was not admitted for %.%: %',
        target.schema_name,target.relation_name,observed_connector_ids
        USING ERRCODE='55000';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM _shopify_admission_relation_security_guard guarded
      LEFT JOIN pg_class current_value ON current_value.oid=guarded.relation_oid
     WHERE current_value.oid IS NULL
        OR current_value.relowner IS DISTINCT FROM guarded.relowner
        OR current_value.relacl IS DISTINCT FROM guarded.relacl
        OR current_value.relrowsecurity IS DISTINCT FROM guarded.relrowsecurity
        OR current_value.relforcerowsecurity IS DISTINCT FROM guarded.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Shopify admission changed a guarded relation owner, ACL, or RLS posture'
      USING ERRCODE='55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM _shopify_admission_function_security_guard guarded
      LEFT JOIN pg_proc current_value ON current_value.oid=guarded.procedure_oid
     WHERE current_value.oid IS NULL
        OR current_value.proowner IS DISTINCT FROM guarded.proowner
        OR current_value.proacl IS DISTINCT FROM guarded.proacl
        OR current_value.prosecdef IS DISTINCT FROM guarded.prosecdef
        OR current_value.proleakproof IS DISTINCT FROM guarded.proleakproof
        OR current_value.proisstrict IS DISTINCT FROM guarded.proisstrict
        OR current_value.provolatile IS DISTINCT FROM guarded.provolatile
        OR current_value.proparallel IS DISTINCT FROM guarded.proparallel
        OR current_value.proconfig IS DISTINCT FROM guarded.proconfig
        OR current_value.prokind IS DISTINCT FROM guarded.prokind
        OR pg_get_functiondef(current_value.oid) NOT LIKE
           '%p_connector_id NOT IN (''lightspeed-r'',''xero'',''deputy'',''momence'',''square'',''shopify'')%'
  ) THEN
    RAISE EXCEPTION 'Shopify admission changed function security metadata or left a guard closed'
      USING ERRCODE='55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc procedure
      JOIN (VALUES
        ('quality.register_connector_streams(text,text,bigint,text,jsonb)'::regprocedure),
        ('quality.record_reconciliation_snapshot_page(text,text,bigint,text,text,text,integer,text,text,text,jsonb,bigint,bigint,boolean,bigint)'::regprocedure),
        ('quality.publish_connector_quality_results(text,text,text,text,text,text,jsonb)'::regprocedure),
        ('semantic_internal.publish_connector_capability_observations(text,text,text,text,text,timestamp with time zone,jsonb)'::regprocedure)
      ) required_function(procedure_oid)
        ON required_function.procedure_oid=procedure.oid
     WHERE procedure.prokind='f'
       AND pg_get_functiondef(procedure.oid) LIKE
           '%p_connector_id NOT IN (''lightspeed-r'',''xero'',''deputy'',''momence'',''square'')%'
  ) THEN
    RAISE EXCEPTION 'A production Shopify runtime function retained the predecessor connector guard'
      USING ERRCODE='55000';
  END IF;

  -- connector_pack_release is migration-owner state. Do not let a hosted
  -- Supabase API role or PUBLIC gain direct access through environment defaults.
  IF EXISTS (
    SELECT 1
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(class.relacl,acldefault('r',class.relowner))) acl
      LEFT JOIN pg_roles role_value ON role_value.oid=acl.grantee
     WHERE namespace.nspname='semantic_internal'
       AND class.relname='connector_pack_release'
       AND (acl.grantee=0 OR role_value.rolname IN ('anon','authenticated','service_role'))
  ) THEN
    RAISE EXCEPTION 'Shopify release authority is exposed to PUBLIC or a Supabase API role'
      USING ERRCODE='42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM _shopify_admission_function_security_guard guarded
      JOIN pg_proc current_value ON current_value.oid=guarded.procedure_oid
      CROSS JOIN LATERAL aclexplode(coalesce(current_value.proacl,acldefault('f',current_value.proowner))) acl
      LEFT JOIN pg_roles role_value ON role_value.oid=acl.grantee
     WHERE acl.grantee=0 OR role_value.rolname IN ('anon','authenticated','service_role')
  ) THEN
    RAISE EXCEPTION 'A Shopify-admitted SECURITY DEFINER runtime function is API-role executable'
      USING ERRCODE='42501';
  END IF;
END
$$;

COMMIT;
