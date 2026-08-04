BEGIN;

-- INSERT ... ON CONFLICT against quarantine_items requires SELECT so the sync
-- runtime can detect the open-item unique key. INSERT-only left dogfood sync
-- failing with permission denied after raw batches had already landed.
GRANT SELECT, INSERT ON TABLE control_plane.quarantine_items TO albert_sync_control;

COMMIT;
