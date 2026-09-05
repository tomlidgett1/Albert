-- Each Fivetran Xero connection writes its native tables into a unique
-- destination schema (xero_<connection_id>) so two organisations never share
-- a Fivetran schema name.

BEGIN;

ALTER TABLE control_plane.fivetran_connections
  DROP CONSTRAINT IF EXISTS fivetran_connections_destination_schema_key;

ALTER TABLE control_plane.fivetran_connections
  ADD CONSTRAINT fivetran_connections_destination_schema_key
  UNIQUE (destination_schema);

COMMENT ON COLUMN control_plane.fivetran_connections.destination_schema IS
  'Fivetran-native destination schema for this connection only. Never the shared name xero.';

COMMIT;
