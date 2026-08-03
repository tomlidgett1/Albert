BEGIN;

-- The semantic service needs to prove that every analytical authority
-- contributor is still a live control-plane connection.  It must not receive
-- OAuth references, account metadata, user identifiers, or any credential
-- material to do so.
CREATE OR REPLACE FUNCTION control_plane.semantic_connection_scopes()
RETURNS TABLE (
  connection_id text,
  connector_id text,
  display_name text,
  connection_generation bigint,
  connection_status text,
  auth_health text,
  authority_eligible boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path=pg_catalog
AS $$
DECLARE
  selected_tenant text:=nullif(current_setting('albert.tenant_id',true),'');
BEGIN
  IF selected_tenant IS NULL OR NOT control_plane.is_ulid(selected_tenant) THEN
    RAISE EXCEPTION 'semantic connection tenant scope is missing or invalid'
      USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  SELECT connection.connection_id,
         connection.connector_key,
         connection.display_name,
         connection.connection_generation,
         connection.status,
         connection.auth_health,
         connection.status IN ('connected','degraded')
           AND connection.auth_health IN ('healthy','expiring')
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id=selected_tenant
     AND connection.status<>'disconnected'
   ORDER BY connection.connector_key,connection.connection_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.semantic_progressive_stream_coverage()
RETURNS TABLE (
  connection_id text,
  stream text,
  status text,
  covered_from timestamptz,
  covered_to timestamptz,
  qualification text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path=pg_catalog
AS $$
DECLARE
  selected_tenant text:=nullif(current_setting('albert.tenant_id',true),'');
BEGIN
  IF selected_tenant IS NULL OR NOT control_plane.is_ulid(selected_tenant) THEN
    RAISE EXCEPTION 'semantic coverage tenant scope is missing or invalid'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT coverage.connection_id,coverage.stream,coverage.status,
         coverage.covered_from,coverage.covered_to,coverage.qualification
    FROM control_plane.progressive_stream_coverage AS coverage
    JOIN control_plane.connections AS connection
      ON connection.tenant_id=coverage.tenant_id
     AND connection.connection_id=coverage.connection_id
     AND connection.connection_generation=coverage.connection_generation
   WHERE coverage.tenant_id=selected_tenant
     AND coverage.phase='recent'
     AND connection.status<>'disconnected'
   ORDER BY coverage.connection_id,coverage.stream;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.semantic_connection_scopes(),
  control_plane.semantic_progressive_stream_coverage()
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.semantic_connection_scopes(),
  control_plane.semantic_progressive_stream_coverage()
  TO albert_semantic_control;

COMMIT;
