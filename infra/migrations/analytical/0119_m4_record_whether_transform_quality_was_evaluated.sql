-- The quality gates run once per sync run, on the page that completes its
-- stream. Every earlier page commits with fail-closed 'blocked' statuses that
-- were never measured, and a replay of such a page reconstructs its result from
-- this table. Without a record of whether the gates actually ran, the replay
-- reports an unmeasured page as a quality verdict, exactly as the original did.
--
-- Existing rows default to true: they keep the historical reading, and only
-- pages committed after this migration can be recognised as ungated.

BEGIN;

ALTER TABLE semantic_internal.canonical_transform_commits
  ADD COLUMN IF NOT EXISTS quality_evaluated boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN semantic_internal.canonical_transform_commits.quality_evaluated IS
  'False when this page committed before its stream extraction was durably complete, so the readiness quality gates never ran for it and its recorded statuses are fail-closed placeholders rather than measurements.';

COMMIT;
