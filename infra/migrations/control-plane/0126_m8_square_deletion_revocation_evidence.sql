BEGIN;

-- The protected deletion proof vocabulary originally predated Square and the
-- independently admitted Lightspeed X-Series connector. Supersede the same
-- function OID so already-connected control-plane sessions invalidate cached
-- plans immediately, while retaining every exact field and failure check.
CREATE OR REPLACE FUNCTION control_plane.require_privacy_safe_remote_revocation(
  p_remote jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path=pg_catalog
AS $$
DECLARE
  target jsonb;
  target_count bigint;
  target_status text;
  error_code text;
  error_class text;
  expected_error_class text;
BEGIN
  IF jsonb_typeof(p_remote) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'remote revocation proof fields are invalid'
      USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_remote)) NOT IN (5,7)
     OR (p_remote ?& ARRAY[
       'attemptedAt','priorStatus','targetCount','targets','bestEffort'
     ]) IS DISTINCT FROM true
     OR jsonb_typeof(p_remote->'attemptedAt') IS DISTINCT FROM 'string'
     OR p_remote->>'attemptedAt' !~
       '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     OR jsonb_typeof(p_remote->'priorStatus') IS DISTINCT FROM 'string'
     OR p_remote->>'priorStatus' NOT IN (
       'pending','succeeded','unsupported','failed','not_applicable'
     )
     OR jsonb_typeof(p_remote->'targetCount') IS DISTINCT FROM 'number'
     OR (p_remote->'targetCount')::text !~ '^(0|[1-9][0-9]*)$'
     OR length((p_remote->'targetCount')::text)>18
     OR jsonb_typeof(p_remote->'targets') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_remote->'bestEffort') IS DISTINCT FROM 'boolean'
     OR (p_remote->'bestEffort')<>'true'::jsonb THEN
    RAISE EXCEPTION 'remote revocation proof fields are invalid'
      USING ERRCODE='55000';
  END IF;
  target_count:=((p_remote->'targetCount')::text)::bigint;
  IF (SELECT count(*) FROM jsonb_object_keys(p_remote))=7 AND (
       (p_remote ?& ARRAY['forcedLocalDestruction','reason']) IS DISTINCT FROM true
       OR jsonb_typeof(p_remote->'forcedLocalDestruction') IS DISTINCT FROM 'boolean'
       OR (p_remote->'forcedLocalDestruction')<>'true'::jsonb
       OR jsonb_typeof(p_remote->'reason') IS DISTINCT FROM 'string'
       OR p_remote->>'reason'<>'remote_revocation_grace_expired'
       OR p_remote->>'priorStatus'<>'failed'
       OR target_count<>0
     ) THEN
    RAISE EXCEPTION 'forced local destruction proof is invalid'
      USING ERRCODE='55000';
  END IF;
  IF target_count<>jsonb_array_length(p_remote->'targets') THEN
    RAISE EXCEPTION 'remote revocation target count is inconsistent'
      USING ERRCODE='55000';
  END IF;
  FOR target IN
    SELECT item.value FROM jsonb_array_elements(p_remote->'targets') item
  LOOP
    IF jsonb_typeof(target) IS DISTINCT FROM 'object'
       OR (target ?& ARRAY['provider','connectionGeneration','status']) IS DISTINCT FROM true
       OR jsonb_typeof(target->'provider') IS DISTINCT FROM 'string'
       OR target->>'provider' NOT IN (
         'lightspeed-r','lightspeed-x','xero','deputy','square'
       )
       OR jsonb_typeof(target->'connectionGeneration') IS DISTINCT FROM 'number'
       OR (target->'connectionGeneration')::text !~ '^[1-9][0-9]*$'
       OR length((target->'connectionGeneration')::text)>18
       OR jsonb_typeof(target->'status') IS DISTINCT FROM 'string'
       OR target->>'status' NOT IN ('succeeded','unsupported','failed') THEN
      RAISE EXCEPTION 'remote revocation target fields are invalid'
        USING ERRCODE='55000';
    END IF;
    target_status:=target->>'status';
    IF target_status<>'failed' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(target))<>3 THEN
        RAISE EXCEPTION 'successful remote revocation target has extra fields'
          USING ERRCODE='55000';
      END IF;
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(target))<>6
       OR (target ?& ARRAY['errorCode','errorClass','correlationId']) IS DISTINCT FROM true
       OR jsonb_typeof(target->'errorCode') IS DISTINCT FROM 'string'
       OR jsonb_typeof(target->'errorClass') IS DISTINCT FROM 'string'
       OR jsonb_typeof(target->'correlationId') IS DISTINCT FROM 'string'
       OR target->>'correlationId' !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
      RAISE EXCEPTION 'failed remote revocation evidence is invalid'
        USING ERRCODE='55000';
    END IF;
    error_code:=target->>'errorCode';
    error_class:=target->>'errorClass';
    expected_error_class:=CASE
      WHEN error_code IN (
        'connector_authentication_required','connector_capability_unavailable',
        'connector_configuration_invalid','connector_credential_conflict',
        'connector_cursor_invalid','connector_oauth_exchange_failed',
        'connector_rate_limited','connector_remote_response_invalid',
        'connector_remote_unavailable','connector_webhook_signature_invalid'
      ) THEN 'connector'
      WHEN error_code IN (
        'database_serialization_conflict','database_deadlock',
        'database_permission_denied','deletion_fence_conflict',
        'database_unavailable','database_integrity_violation'
      ) THEN 'database'
      WHEN error_code IN ('operation_aborted','operation_timeout') THEN 'timeout'
      WHEN error_code IN (
        'internal_type_error','internal_syntax_error','unexpected_deletion_failure'
      ) THEN 'internal'
      ELSE NULL
    END;
    IF expected_error_class IS NULL
       OR error_class IS DISTINCT FROM expected_error_class THEN
      RAISE EXCEPTION 'failed remote revocation code is invalid'
        USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION
  control_plane.require_privacy_safe_remote_revocation(jsonb)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_deletion_control;

GRANT EXECUTE ON FUNCTION
  control_plane.require_privacy_safe_remote_revocation(jsonb)
TO albert_control_migration_owner;

COMMIT;
