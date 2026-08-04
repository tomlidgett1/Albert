BEGIN;

-- Sync commit must hold the connection row while advancing cursors so a
-- concurrent reconnect cannot bump connection_generation mid-commit. Migration
-- 0040 revoked UPDATE on connections from albert_sync_control, and SELECT
-- FOR UPDATE / FOR SHARE both fail under that grant set on this host. Fence
-- through a SECURITY DEFINER routine owned by the migration role instead.

CREATE OR REPLACE FUNCTION control_plane.assert_sync_connection_generation_fence(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  found_generation bigint;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_sync_control_runtime', 'albert_sync_control'
  );
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR p_connection_generation < 1 THEN
    RAISE EXCEPTION 'connection generation fence input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT connection.connection_generation
    INTO found_generation
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id = p_tenant_id
     AND connection.connection_id = p_connection_id
     AND connection.connection_generation = p_connection_generation
     AND connection.status IN ('connected', 'degraded')
   FOR SHARE;

  RETURN found_generation IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.assert_sync_connection_generation_fence(text, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
       albert_webhook_control, albert_transform_control, albert_semantic_control,
       albert_operator_diagnostic_control, albert_deletion_control;

GRANT EXECUTE ON FUNCTION control_plane.assert_sync_connection_generation_fence(text, text, bigint)
  TO albert_sync_control;

COMMIT;
