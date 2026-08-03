BEGIN;

-- Live vendor proof is intentionally written by a trust-domain service, not
-- by the candidate release.  The LOGIN is provisioned separately from the
-- trusted-tooling environment; this group has no password and is unavailable
-- to every Albert runtime.
DO $$
DECLARE role_attributes record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname='albert_vendor_connection_attestor'
  ) THEN
    CREATE ROLE albert_vendor_connection_attestor
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;

  SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    INTO STRICT role_attributes
    FROM pg_catalog.pg_roles
   WHERE rolname='albert_vendor_connection_attestor';
  IF role_attributes.rolsuper OR role_attributes.rolcreatedb
     OR role_attributes.rolcreaterole OR role_attributes.rolreplication
     OR role_attributes.rolbypassrls THEN
    RAISE EXCEPTION 'existing vendor connection attestor role has unsafe attributes';
  END IF;
END;
$$;

-- Supabase's managed postgres identity has CREATEROLE but is not a true
-- superuser. Its supautils hook rejects ALTER ROLE statements that restate
-- privileged attributes, even as false. The guard above fails closed on those
-- attributes, so this statement changes only properties it may safely manage.
ALTER ROLE albert_vendor_connection_attestor NOLOGIN NOINHERIT;
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_vendor_connection_attestor',
    current_database()
  );
END;
$$;

DO $$
DECLARE existing_owner text;
BEGIN
  IF to_regclass('extensions.albert_vendor_attestor_verifier') IS NULL THEN
    CREATE TABLE extensions.albert_vendor_attestor_verifier (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      key_id text NOT NULL CHECK (key_id~'^ed25519:[a-f0-9]{64}$'),
      public_key_spki_der bytea NOT NULL CHECK (octet_length(public_key_spki_der) BETWEEN 40 AND 256),
      tool_ref text NOT NULL CHECK (tool_ref~'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[a-f0-9]{40}$'),
      build_digest text NOT NULL CHECK (build_digest~'^sha256:[a-f0-9]{64}$'),
      admission_hmac_key bytea NOT NULL CHECK (octet_length(admission_hmac_key)=32),
      configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      configured_by text NOT NULL DEFAULT session_user
    );
    ALTER TABLE extensions.albert_vendor_attestor_verifier OWNER TO postgres;
  ELSE
    SELECT owner.rolname INTO existing_owner
      FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_roles owner ON owner.oid=class.relowner
     WHERE class.oid=to_regclass('extensions.albert_vendor_attestor_verifier')
       AND class.relkind='r' AND NOT class.relispartition;
    IF existing_owner IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'vendor attestor verifier was not created by protected bootstrap';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON TABLE extensions.albert_vendor_attestor_verifier
  FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;

-- This marker makes the migration-owner hand-off a one-use ceremony.  It is
-- deliberately bootstrap-owned, unreadable by candidate roles, and preserved
-- across bootstrap re-runs.  An already-finalized boundary cannot be emptied
-- and handed over a second time by replaying the finalizer.
DO $$
DECLARE existing_owner text;
BEGIN
  IF to_regclass('extensions.albert_vendor_attestor_boundary_state') IS NULL THEN
    CREATE TABLE extensions.albert_vendor_attestor_boundary_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      finalized_at timestamptz,
      contract_digest text CHECK (
        contract_digest IS NULL OR contract_digest~'^[a-f0-9]{64}$'
      ),
      finalized_by text
    );
    ALTER TABLE extensions.albert_vendor_attestor_boundary_state OWNER TO postgres;
    INSERT INTO extensions.albert_vendor_attestor_boundary_state(singleton)
    VALUES(true);
  ELSE
    SELECT owner.rolname INTO existing_owner
      FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_roles owner ON owner.oid=class.relowner
     WHERE class.oid=to_regclass('extensions.albert_vendor_attestor_boundary_state')
       AND class.relkind='r' AND NOT class.relispartition;
    IF existing_owner IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'vendor attestor boundary marker was not created by protected bootstrap';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON TABLE extensions.albert_vendor_attestor_boundary_state
  FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;

CREATE OR REPLACE FUNCTION extensions.albert_configure_vendor_attestor_verifier(
  p_key_id text,p_public_key_spki_base64 text,p_tool_ref text,
  p_build_digest text,p_admission_hmac_key_base64 text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE public_key bytea;
DECLARE admission_key bytea;
BEGIN
  IF session_user<>'postgres' OR current_user<>'postgres' THEN
    RAISE EXCEPTION 'vendor attestor verifier provisioning requires protected postgres';
  END IF;
  BEGIN
    public_key:=decode(p_public_key_spki_base64,'base64');
    admission_key:=decode(p_admission_hmac_key_base64,'base64');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'vendor attestor verifier material is malformed';
  END;
  IF coalesce(p_key_id,'')!~'^ed25519:[a-f0-9]{64}$'
     OR p_key_id<>'ed25519:'||encode(extensions.digest(public_key,'sha256'),'hex')
     OR octet_length(public_key) NOT BETWEEN 40 AND 256
     OR coalesce(p_tool_ref,'')!~'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[a-f0-9]{40}$'
     OR coalesce(p_build_digest,'')!~'^sha256:[a-f0-9]{64}$'
     OR octet_length(admission_key)<>32 THEN
    RAISE EXCEPTION 'vendor attestor verifier material is invalid';
  END IF;
  INSERT INTO extensions.albert_vendor_attestor_verifier(
    singleton,key_id,public_key_spki_der,tool_ref,build_digest,
    admission_hmac_key,configured_at,configured_by
  ) VALUES(
    true,p_key_id,public_key,p_tool_ref,p_build_digest,
    admission_key,clock_timestamp(),session_user
  ) ON CONFLICT(singleton) DO UPDATE SET
    key_id=excluded.key_id,
    public_key_spki_der=excluded.public_key_spki_der,
    tool_ref=excluded.tool_ref,
    build_digest=excluded.build_digest,
    admission_hmac_key=excluded.admission_hmac_key,
    configured_at=excluded.configured_at,
    configured_by=excluded.configured_by;
END;
$$;
REVOKE ALL ON FUNCTION extensions.albert_configure_vendor_attestor_verifier(
  text,text,text,text,text
) FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;

CREATE OR REPLACE FUNCTION extensions.albert_vendor_attestation_json_digest(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT encode(extensions.digest(convert_to(p_value::text,'UTF8'),'sha256'),'hex')
$$;
ALTER FUNCTION extensions.albert_vendor_attestation_json_digest(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION extensions.albert_vendor_attestation_json_digest(jsonb)
  FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;

CREATE OR REPLACE FUNCTION extensions.albert_guard_vendor_attestation_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE'
     OR OLD.consumed_at IS NOT NULL
     OR NEW.consumption_id IS NULL OR NEW.consumed_at IS NULL
     OR (to_jsonb(NEW)-ARRAY['consumption_id','consumed_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumption_id','consumed_at']) THEN
    RAISE EXCEPTION 'independent vendor attestation result is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION extensions.albert_guard_vendor_attestation_result() OWNER TO postgres;
REVOKE ALL ON FUNCTION extensions.albert_guard_vendor_attestation_result()
  FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;

CREATE OR REPLACE FUNCTION extensions.albert_reject_vendor_attestation_consumption_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'independent vendor attestation consumption is immutable'
    USING ERRCODE='55000';
END;
$$;
ALTER FUNCTION extensions.albert_reject_vendor_attestation_consumption_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION extensions.albert_reject_vendor_attestation_consumption_mutation()
  FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;

-- Migration 0067 creates the reviewed shape after its M7 dependencies exist.
-- This fixed administrator capability empties it, transfers ownership to
-- postgres, and installs the final ACL.  Consequently the ordinary migration
-- owner cannot seed, replace, or rewrite independent proof after hand-off.
CREATE OR REPLACE FUNCTION extensions.albert_finalize_vendor_attestation_boundary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE object_name text;
DECLARE function_name text;
DECLARE trigger_name text;
DECLARE expected_source_digest text;
DECLARE expected_language text;
DECLARE expected_volatility "char";
DECLARE expected_result text;
DECLARE function_contract record;
DECLARE expected_columns jsonb;
DECLARE actual_columns jsonb;
DECLARE finalized_at timestamptz;
BEGIN
  IF current_user<>'postgres' THEN
    RAISE EXCEPTION 'vendor attestation finalizer must remain postgres-owned';
  END IF;
  SELECT state.finalized_at INTO finalized_at
    FROM extensions.albert_vendor_attestor_boundary_state state
   WHERE state.singleton
   FOR UPDATE;
  IF NOT FOUND OR finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'vendor attestation boundary hand-off is unavailable or already finalized';
  END IF;
  FOREACH object_name IN ARRAY ARRAY[
    'control_plane.live_vendor_attestation_challenges',
    'control_plane.live_vendor_attestation_results',
    'control_plane.live_vendor_attestation_consumptions'
  ] LOOP
    IF to_regclass(object_name) IS NULL THEN
      RAISE EXCEPTION 'vendor attestation boundary is incomplete: %',object_name;
    END IF;
    expected_columns:=CASE object_name
      WHEN 'control_plane.live_vendor_attestation_challenges' THEN $columns$
        [["challenge_id","text",true],["journey_id","text",true],
         ["candidate_sha","text",true],["deployment_id","text",true],
         ["tenant_id","text",true],["provider","text",true],
         ["connection_id","text",true],["connection_generation","bigint",true],
         ["selected_external_account_digest","text",true],
         ["credential_reference_digest","text",true],
         ["challenge_nonce_digest","text",true],["relay_nonce","text",false],
         ["status","text",true],["relay_worker_id","text",false],
         ["issued_at","timestamp with time zone",true],
         ["expires_at","timestamp with time zone",true],
         ["relayed_at","timestamp with time zone",false],
         ["attestor_claimed_at","timestamp with time zone",false],
         ["completed_at","timestamp with time zone",false]]
      $columns$::jsonb
      WHEN 'control_plane.live_vendor_attestation_results' THEN $columns$
        [["challenge_id","text",true],["journey_id","text",true],
         ["candidate_sha","text",true],["deployment_id","text",true],
         ["tenant_id","text",true],["provider","text",true],
         ["connection_id","text",true],["connection_generation","bigint",true],
         ["selected_external_account_digest","text",true],
         ["credential_reference_digest","text",true],
         ["challenge_nonce_digest","text",true],["passed","boolean",true],
         ["result_binding","jsonb",true],["result_digest","text",true],
         ["signature","text",true],["admission_mac","text",true],
         ["completed_at","timestamp with time zone",true],
         ["expires_at","timestamp with time zone",true],
         ["consumption_id","text",false],
         ["consumed_at","timestamp with time zone",false]]
      $columns$::jsonb
      ELSE $columns$
        [["consumption_id","text",true],["journey_id","text",true],
         ["candidate_sha","text",true],["deployment_id","text",true],
         ["tenant_id","text",true],["evidence","jsonb",true],
         ["evidence_digest","text",true],
         ["consumed_at","timestamp with time zone",true]]
      $columns$::jsonb END;
    SELECT jsonb_agg(jsonb_build_array(
             attribute.attname,
             format_type(attribute.atttypid,attribute.atttypmod),
             attribute.attnotnull
           ) ORDER BY attribute.attnum)
      INTO actual_columns
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid=to_regclass(object_name)
       AND attribute.attnum>0 AND NOT attribute.attisdropped;
    IF actual_columns IS DISTINCT FROM expected_columns
       OR NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class class
         JOIN pg_catalog.pg_roles owner ON owner.oid=class.relowner
          WHERE class.oid=to_regclass(object_name)
            AND class.relkind='r' AND NOT class.relispartition
            AND owner.rolname='albert_control_migration_owner'
       )
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_inherits inheritance
          WHERE inheritance.inhrelid=to_regclass(object_name)
             OR inheritance.inhparent=to_regclass(object_name)
       )
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_rewrite rule
          WHERE rule.ev_class=to_regclass(object_name)
       ) THEN
      RAISE EXCEPTION 'vendor attestation table shape is untrusted: %',object_name;
    END IF;
  END LOOP;
  FOREACH function_name IN ARRAY ARRAY[
    'control_plane.issue_live_vendor_connection_attestation(text,text,text,text)',
    'control_plane.claim_live_vendor_attestation_relay(text)',
    'control_plane.claim_live_vendor_connection_attestation(text,text)',
    'control_plane.prepare_live_vendor_connection_attestation_result(text,jsonb)',
    'control_plane.complete_live_vendor_connection_attestation(text,jsonb,text,text,text)',
    'control_plane.live_vendor_connection_attestation_status(text,text,text,text)',
    'control_plane.consume_live_vendor_connection_attestations(text,text,text,text)',
    'control_plane.assert_consumed_live_vendor_connection_attestations(text,text,text,text,text)',
    'control_plane.assert_live_vendor_attestation_boundary_ready()',
    'control_plane.capture_protected_dogfood_acceptance(text,text,text,jsonb,text,integer,text,text,text,text,text,text)',
    'control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)'
  ] LOOP
    IF to_regprocedure(function_name) IS NULL THEN
      RAISE EXCEPTION 'vendor attestation function is incomplete: %',function_name;
    END IF;
    expected_source_digest:=CASE function_name
      WHEN 'control_plane.issue_live_vendor_connection_attestation(text,text,text,text)'
        THEN '845ed1031cc95ae5718c7a7f2cc24f5ce03efaac8aa4f12a0a4483f14807bce7'
      WHEN 'control_plane.claim_live_vendor_attestation_relay(text)'
        THEN '4ffdf5882b0d776301d14121bbe21de62a04cef460f3ba2f5dad3e57f26cbd68'
      WHEN 'control_plane.claim_live_vendor_connection_attestation(text,text)'
        THEN '25a9deb323151eac030a97ddae805f09d003ae2279d87f703d64596721e91a98'
      WHEN 'control_plane.prepare_live_vendor_connection_attestation_result(text,jsonb)'
        THEN '1c6ddd56c6c39d7f6b4c5d37d05b1ca44200dd806b6aeee7a07aa5a1957a7707'
      WHEN 'control_plane.complete_live_vendor_connection_attestation(text,jsonb,text,text,text)'
        THEN '532905bfcd799801631a6f42bd43b7d2ee12cc858553d9311c83750a89af0623'
      WHEN 'control_plane.live_vendor_connection_attestation_status(text,text,text,text)'
        THEN '9eec362e0f7431f045594400a6e57bcd75a3e44530de34a0c2da0f1f2d2d29bd'
      WHEN 'control_plane.consume_live_vendor_connection_attestations(text,text,text,text)'
        THEN '5c2b13b714995c33607e5a07422014495399a4c19bd2425d28af576b5776a992'
      WHEN 'control_plane.assert_consumed_live_vendor_connection_attestations(text,text,text,text,text)'
        THEN '755f3fec5a7b60af75213203588b1927c2b318355ce35b7ea5229e7c8400ca2e'
      WHEN 'control_plane.assert_live_vendor_attestation_boundary_ready()'
        THEN '530e787d7d006e81a4a723940c3908f729368df7e41f4263cae24828ed59315f'
      WHEN 'control_plane.capture_protected_dogfood_acceptance(text,text,text,jsonb,text,integer,text,text,text,text,text,text)'
        THEN 'c1d138a2b42f878c92ba2541579215e161d87e781bca210b3693d7635a24dd56'
      ELSE 'b0ecce21a200bab095aaee1f6f231f229786703ba14a627ba7385aef1a301503' END;
    expected_language:=CASE WHEN function_name LIKE
      'control_plane.live_vendor_connection_attestation_status(%'
      THEN 'sql' ELSE 'plpgsql' END;
    expected_volatility:=CASE WHEN function_name LIKE
      'control_plane.live_vendor_connection_attestation_status(%'
      OR function_name LIKE
      'control_plane.assert_consumed_live_vendor_connection_attestations(%'
      OR function_name='control_plane.assert_live_vendor_attestation_boundary_ready()'
      THEN 's' ELSE 'v' END;
    expected_result:=CASE
      WHEN function_name LIKE 'control_plane.prepare_live_vendor_connection_attestation_result(%'
        THEN 'text'
      WHEN function_name='control_plane.assert_live_vendor_attestation_boundary_ready()'
        THEN 'boolean'
      WHEN function_name='control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)'
        THEN 'boolean'
      ELSE 'jsonb' END;
    SELECT encode(extensions.digest(convert_to(procedure.prosrc,'UTF8'),'sha256'),'hex') AS source_digest,
           language.lanname,procedure.prosecdef,procedure.provolatile,
           procedure.proconfig,pg_get_function_result(procedure.oid) AS result_type,
           owner.rolname AS owner_name
      INTO function_contract
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_language language ON language.oid=procedure.prolang
      JOIN pg_catalog.pg_roles owner ON owner.oid=procedure.proowner
     WHERE procedure.oid=to_regprocedure(function_name);
    IF function_contract.source_digest<>expected_source_digest
       OR function_contract.lanname<>expected_language
       OR function_contract.prosecdef IS DISTINCT FROM true
       OR function_contract.provolatile<>expected_volatility
       OR function_contract.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
       OR function_contract.result_type<>expected_result
       OR function_contract.owner_name<>'albert_control_migration_owner' THEN
      RAISE EXCEPTION 'vendor attestation function body is not administrator-approved: %',function_name;
    END IF;
  END LOOP;

  -- A candidate migration cannot pre-seed evidence before the ownership
  -- transfer.  The fixed function always starts the administrator-owned store
  -- empty on first installation.
  TRUNCATE TABLE
    control_plane.live_vendor_attestation_results,
    control_plane.live_vendor_attestation_consumptions,
    control_plane.live_vendor_attestation_challenges;

  FOR object_name IN SELECT unnest(ARRAY[
    'control_plane.live_vendor_attestation_challenges',
    'control_plane.live_vendor_attestation_results',
    'control_plane.live_vendor_attestation_consumptions'
  ]) LOOP
    FOR trigger_name IN
      SELECT trigger.tgname FROM pg_catalog.pg_trigger trigger
       WHERE trigger.tgrelid=to_regclass(object_name) AND NOT trigger.tgisinternal
    LOOP
      EXECUTE format('DROP TRIGGER %I ON %s',trigger_name,object_name);
    END LOOP;
  END LOOP;

  ALTER TABLE control_plane.live_vendor_attestation_challenges OWNER TO postgres;
  ALTER TABLE control_plane.live_vendor_attestation_results OWNER TO postgres;
  ALTER TABLE control_plane.live_vendor_attestation_consumptions OWNER TO postgres;
  EXECUTE $trigger$
    CREATE TRIGGER live_vendor_attestation_results_guard
      BEFORE UPDATE OR DELETE ON control_plane.live_vendor_attestation_results
      FOR EACH ROW EXECUTE FUNCTION extensions.albert_guard_vendor_attestation_result()
  $trigger$;
  EXECUTE $trigger$
    CREATE TRIGGER live_vendor_attestation_consumptions_guard
      BEFORE UPDATE OR DELETE ON control_plane.live_vendor_attestation_consumptions
      FOR EACH ROW EXECUTE FUNCTION extensions.albert_reject_vendor_attestation_consumption_mutation()
  $trigger$;

  ALTER FUNCTION control_plane.issue_live_vendor_connection_attestation(text,text,text,text) OWNER TO postgres;
  ALTER FUNCTION control_plane.claim_live_vendor_attestation_relay(text) OWNER TO postgres;
  ALTER FUNCTION control_plane.claim_live_vendor_connection_attestation(text,text) OWNER TO postgres;
  ALTER FUNCTION control_plane.prepare_live_vendor_connection_attestation_result(text,jsonb) OWNER TO postgres;
  ALTER FUNCTION control_plane.complete_live_vendor_connection_attestation(text,jsonb,text,text,text) OWNER TO postgres;
  ALTER FUNCTION control_plane.live_vendor_connection_attestation_status(text,text,text,text) OWNER TO postgres;
  ALTER FUNCTION control_plane.consume_live_vendor_connection_attestations(text,text,text,text) OWNER TO postgres;
  ALTER FUNCTION control_plane.assert_consumed_live_vendor_connection_attestations(text,text,text,text,text) OWNER TO postgres;
  ALTER FUNCTION control_plane.assert_live_vendor_attestation_boundary_ready() OWNER TO postgres;
  ALTER FUNCTION control_plane.capture_protected_dogfood_acceptance(
    text,text,text,jsonb,text,integer,text,text,text,text,text,text
  ) OWNER TO postgres;
  ALTER FUNCTION control_plane.consume_protected_dogfood_acceptance(
    text,text,text,text,text
  ) OWNER TO postgres;

  REVOKE ALL ON TABLE
    control_plane.live_vendor_attestation_challenges,
    control_plane.live_vendor_attestation_results,
    control_plane.live_vendor_attestation_consumptions
  FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane
    FROM albert_vendor_connection_attestor;
  GRANT USAGE ON SCHEMA control_plane,extensions
    TO albert_vendor_connection_attestor;

  REVOKE ALL ON FUNCTION
    control_plane.issue_live_vendor_connection_attestation(text,text,text,text),
    control_plane.claim_live_vendor_attestation_relay(text),
    control_plane.claim_live_vendor_connection_attestation(text,text),
    control_plane.prepare_live_vendor_connection_attestation_result(text,jsonb),
    control_plane.complete_live_vendor_connection_attestation(text,jsonb,text,text,text),
    control_plane.live_vendor_connection_attestation_status(text,text,text,text),
    control_plane.consume_live_vendor_connection_attestations(text,text,text,text),
    control_plane.assert_consumed_live_vendor_connection_attestations(text,text,text,text,text),
    control_plane.assert_live_vendor_attestation_boundary_ready(),
    control_plane.capture_protected_dogfood_acceptance(
      text,text,text,jsonb,text,integer,text,text,text,text,text,text
    ),
    control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role,
       albert_control_migration_owner,albert_sync_control,
       albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;

  GRANT EXECUTE ON FUNCTION
    control_plane.issue_live_vendor_connection_attestation(text,text,text,text),
    control_plane.live_vendor_connection_attestation_status(text,text,text,text),
    control_plane.consume_live_vendor_connection_attestations(text,text,text,text),
    control_plane.assert_consumed_live_vendor_connection_attestations(text,text,text,text,text),
    control_plane.capture_protected_dogfood_acceptance(
      text,text,text,jsonb,text,integer,text,text,text,text,text,text
    ),
    control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)
  TO albert_operator_diagnostic_control;
  GRANT EXECUTE ON FUNCTION
    control_plane.claim_live_vendor_attestation_relay(text)
  TO albert_sync_control;
  GRANT EXECUTE ON FUNCTION
    control_plane.claim_live_vendor_connection_attestation(text,text),
    control_plane.prepare_live_vendor_connection_attestation_result(text,jsonb),
    control_plane.complete_live_vendor_connection_attestation(text,jsonb,text,text,text),
    control_plane.assert_live_vendor_attestation_boundary_ready()
  TO albert_vendor_connection_attestor;

  UPDATE extensions.albert_vendor_attestor_boundary_state state
     SET finalized_at=clock_timestamp(),
         contract_digest='f42b873c652f097a00f4feb730378b2f5030e8eb2b6f36ee590c936c5e915b24',
         finalized_by=session_user
   WHERE state.singleton AND state.finalized_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor attestation boundary hand-off raced or was replayed';
  END IF;
  EXECUTE $revoke$
    REVOKE ALL ON FUNCTION extensions.albert_finalize_vendor_attestation_boundary()
      FROM albert_control_migration_owner
  $revoke$;
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_finalize_vendor_attestation_boundary()
  FROM PUBLIC,anon,authenticated,service_role,
       albert_sync_control,albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control,albert_vendor_connection_attestor;
GRANT EXECUTE ON FUNCTION extensions.albert_finalize_vendor_attestation_boundary()
  TO albert_control_migration_owner;

COMMIT;
