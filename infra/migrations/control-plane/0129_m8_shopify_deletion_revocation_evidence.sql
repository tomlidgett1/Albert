BEGIN;

-- Shopify lifecycle contract (official sources, pinned for implementation):
-- https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/appUninstall
-- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
-- https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens/set-up-session-tokens
-- https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
--
-- appUninstall is an irreversible whole-install operation, not a per-grant
-- OAuth revocation endpoint. An ordinary Albert connection disconnect is not
-- consent to uninstall the app from the merchant store, so the deletion worker
-- cryptographically destroys the complete local credential envelope and
-- truthfully records Shopify vendor revocation as unsupported. For expiring
-- offline grants this also destroys Albert's refresh capability; Shopify can
-- still accept an already-issued access token until it expires. Legacy
-- non-expiring offline grants require app uninstallation or secret revocation
-- for vendor-side invalidation according to Shopify's token documentation.
--
-- app/uninstalled, customers/data_request, customers/redact, and shop/redact
-- are separate authenticated inbound lifecycle/compliance triggers. They must
-- enter the durable privacy workflow; receipt is never evidence that an Albert
-- purge completed. Keep this validator cumulative with every admitted source.
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
         'lightspeed-r','lightspeed-x','xero','deputy','square','momence','shopify'
       )
       OR jsonb_typeof(target->'connectionGeneration') IS DISTINCT FROM 'number'
       OR (target->'connectionGeneration')::text !~ '^[1-9][0-9]*$'
       OR length((target->'connectionGeneration')::text)>18
       OR jsonb_typeof(target->'status') IS DISTINCT FROM 'string'
       OR target->>'status' NOT IN ('succeeded','unsupported','failed')
       -- Local destruction is enforceable, but it is not remote Shopify
       -- revocation. Never allow the immutable proof to claim otherwise.
       OR (
         target->>'provider'='shopify'
         AND target->>'status'='succeeded'
       ) THEN
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

COMMENT ON FUNCTION control_plane.require_privacy_safe_remote_revocation(jsonb) IS
  'Cumulative deletion revocation proof validator. Shopify ordinary disconnect records unsupported vendor revocation after local credential-envelope destruction; it does not call irreversible appUninstall. app/uninstalled and customers/data_request, customers/redact, and shop/redact are inbound lifecycle triggers, never purge-completion evidence. Official sources: https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/appUninstall ; https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens ; https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens/set-up-session-tokens ; https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance';

REVOKE ALL ON FUNCTION
  control_plane.require_privacy_safe_remote_revocation(jsonb)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_deletion_control;

GRANT EXECUTE ON FUNCTION
  control_plane.require_privacy_safe_remote_revocation(jsonb)
TO albert_control_migration_owner;

COMMIT;
