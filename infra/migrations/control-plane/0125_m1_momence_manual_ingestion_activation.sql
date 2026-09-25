-- Momence was authorization-only before pack 1.0. Existing grants therefore
-- carry no implied consent to begin pulling studio data. New OAuth finalization
-- reads this policy from the manifest; this one-time migration covers only
-- pre-existing Momence connections and leaves an already-manual/activated
-- generation untouched on reapplication.

BEGIN;

UPDATE control_plane.connections AS connection
   SET ingestion_start_mode = 'manual',
       ingestion_activated_at = NULL,
       ingestion_activated_by = NULL,
       ingestion_activated_generation = NULL,
       ingestion_blocked_reason = NULL
 WHERE connection.connector_key = 'momence'
   AND connection.ingestion_start_mode <> 'manual';

COMMENT ON COLUMN control_plane.connections.ingestion_activated_generation IS
  'Current connection generation explicitly cleared for ingestion. Any manual-start connector, including Momence, requires equality with connection_generation; reauthorization requires a new user activation.';

COMMIT;
