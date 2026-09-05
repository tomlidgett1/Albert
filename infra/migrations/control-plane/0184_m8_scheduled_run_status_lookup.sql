BEGIN;

-- 0184: Scheduled-run lifecycle becomes lookup-backed (ADR 0131 follow-up).
--
-- 0183 declared the run lifecycle as a literal CHECK list. The control
-- plane keeps lifecycle vocabularies as described lookup tables (0061), so
-- the vocabulary is reviewed in one place and the literal check retires
-- only after the foreign key validates against existing rows. No row
-- changes; the application roles never read the lookup directly.

CREATE TABLE IF NOT EXISTS control_plane.scheduled_run_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.scheduled_run_status_lookup (status, description) VALUES
  ('queued', 'A manual run the owner requested; the bridge scheduler has not picked it up yet.'),
  ('running', 'The bridge has claimed the run and the Omni analysis is in progress.'),
  ('sent', 'The analysis finished and its text bubbles were delivered through Linq.'),
  ('failed', 'The analysis or the delivery failed; the error is recorded on the run.'),
  ('missed', 'The scheduled slot was more than the grace window overdue when found, so nothing was sent.')
ON CONFLICT (status) DO UPDATE SET description = EXCLUDED.description;

REVOKE ALL ON TABLE control_plane.scheduled_run_status_lookup FROM PUBLIC;
REVOKE ALL ON TABLE control_plane.scheduled_run_status_lookup FROM anon;
REVOKE ALL ON TABLE control_plane.scheduled_run_status_lookup FROM authenticated;

ALTER TABLE control_plane.scheduled_task_runs
  DROP CONSTRAINT IF EXISTS scheduled_task_runs_status_fkey;
ALTER TABLE control_plane.scheduled_task_runs
  ADD CONSTRAINT scheduled_task_runs_status_fkey
  FOREIGN KEY (status) REFERENCES control_plane.scheduled_run_status_lookup(status)
  NOT VALID;
ALTER TABLE control_plane.scheduled_task_runs
  VALIDATE CONSTRAINT scheduled_task_runs_status_fkey;
ALTER TABLE control_plane.scheduled_task_runs
  DROP CONSTRAINT IF EXISTS scheduled_task_runs_status_check;

COMMIT;
