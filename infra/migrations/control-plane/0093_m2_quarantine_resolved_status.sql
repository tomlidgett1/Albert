-- The 0044 replay-recovery definer marks healed quarantine rows
-- status='resolved' (with resolved_at and resolution_reason), but the 0003
-- status lookup only ever seeded open/replayed/dismissed. The first real
-- replay over quarantined records therefore died on
-- quarantine_items_status_fkey, failing the whole stream job after its
-- staging writes had already landed. Seed the status the recovery machinery
-- was designed around; 'replayed' remains for rows healed before 0044.

BEGIN;

INSERT INTO control_plane.quarantine_status_lookup (status, description) VALUES
  ('resolved', 'A generation-fenced replay landed the record and healed the quarantine cell')
ON CONFLICT (status) DO NOTHING;

COMMIT;
