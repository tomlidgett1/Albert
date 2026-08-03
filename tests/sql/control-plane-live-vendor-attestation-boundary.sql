\set ON_ERROR_STOP on

DO $$
DECLARE object_name text;
DECLARE function_name text;
DECLARE owner_name text;
DECLARE unsafe_role text;
DECLARE login_contract record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM extensions.albert_vendor_attestor_boundary_state state
     WHERE state.singleton AND state.finalized_at IS NOT NULL
       AND state.contract_digest=
         'f42b873c652f097a00f4feb730378b2f5030e8eb2b6f36ee590c936c5e915b24'
  ) THEN
    RAISE EXCEPTION 'vendor attestor administrator hand-off is not sealed';
  END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'control_plane.live_vendor_attestation_challenges',
    'control_plane.live_vendor_attestation_results',
    'control_plane.live_vendor_attestation_consumptions'
  ] LOOP
    SELECT owner.rolname INTO owner_name
      FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_roles owner ON owner.oid=class.relowner
     WHERE class.oid=to_regclass(object_name);
    IF owner_name IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'independent evidence table is not postgres-owned: %',object_name;
    END IF;
    FOREACH unsafe_role IN ARRAY ARRAY[
      'anon','authenticated','service_role','albert_control_migration_owner',
      'albert_sync_control','albert_webhook_control','albert_transform_control',
      'albert_semantic_control','albert_operator_diagnostic_control',
      'albert_deletion_control','albert_vendor_connection_attestor'
    ] LOOP
      IF has_table_privilege(unsafe_role,object_name,'INSERT')
         OR has_table_privilege(unsafe_role,object_name,'UPDATE')
         OR has_table_privilege(unsafe_role,object_name,'DELETE')
         OR has_table_privilege(unsafe_role,object_name,'TRUNCATE') THEN
        RAISE EXCEPTION 'role % can mutate independent evidence table %',unsafe_role,object_name;
      END IF;
    END LOOP;
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
    SELECT owner.rolname INTO owner_name
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_roles owner ON owner.oid=procedure.proowner
     WHERE procedure.oid=to_regprocedure(function_name);
    IF owner_name IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'trusted vendor-attestation function is not postgres-owned: %',function_name;
    END IF;
    IF has_function_privilege(
      'albert_control_migration_owner',to_regprocedure(function_name),'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'migration owner retained vendor-attestation function: %',function_name;
    END IF;
  END LOOP;

  IF has_function_privilege(
       'albert_control_migration_owner',
       'extensions.albert_finalize_vendor_attestation_boundary()','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'migration owner retained the one-use boundary finalizer';
  END IF;
  IF NOT has_function_privilege(
       'albert_sync_control',
       'control_plane.claim_live_vendor_attestation_relay(text)','EXECUTE'
     ) OR NOT has_function_privilege(
       'albert_operator_diagnostic_control',
       'control_plane.consume_live_vendor_connection_attestations(text,text,text,text)','EXECUTE'
     ) OR NOT has_function_privilege(
       'albert_vendor_connection_attestor',
       'control_plane.complete_live_vendor_connection_attestation(text,jsonb,text,text,text)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'vendor-attestation least-privilege grants are incomplete';
  END IF;
  IF pg_has_role('service_role','albert_vendor_connection_attestor','member')
     OR pg_has_role('albert_sync_control','albert_vendor_connection_attestor','member')
     OR pg_has_role('albert_operator_diagnostic_control','albert_vendor_connection_attestor','member') THEN
    RAISE EXCEPTION 'candidate authority reaches independent vendor attestor role';
  END IF;

  SELECT rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,
         rolreplication,rolbypassrls,rolconnlimit
    INTO login_contract
    FROM pg_catalog.pg_roles
   WHERE rolname='albert_vendor_attestor_runtime';
  IF NOT FOUND OR NOT login_contract.rolcanlogin OR login_contract.rolinherit
     OR login_contract.rolsuper OR login_contract.rolcreaterole
     OR login_contract.rolcreatedb OR login_contract.rolreplication
     OR login_contract.rolbypassrls OR login_contract.rolconnlimit<>4
     OR NOT pg_has_role(
       'albert_vendor_attestor_runtime','albert_vendor_connection_attestor','member'
     ) THEN
    RAISE EXCEPTION 'isolated vendor-attestor runtime login is unsafe';
  END IF;

  IF (SELECT count(*) FROM control_plane.live_vendor_attestation_challenges)<>0
     OR (SELECT count(*) FROM control_plane.live_vendor_attestation_results)<>0
     OR (SELECT count(*) FROM control_plane.live_vendor_attestation_consumptions)<>0 THEN
    RAISE EXCEPTION 'candidate evidence survived the administrator hand-off';
  END IF;

  BEGIN
    PERFORM extensions.albert_finalize_vendor_attestation_boundary();
    RAISE EXCEPTION 'one-use finalizer unexpectedly replayed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%already finalized%' THEN
      RAISE;
    END IF;
  END;
END;
$$;

SELECT 'control-plane live vendor attestation boundary passed' AS result;
