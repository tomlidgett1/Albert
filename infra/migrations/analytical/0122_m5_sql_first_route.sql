-- Open the audited sql_first route.
--
-- query_audit's route CHECK was the closed set ('semantic','source_exploration'),
-- which made the constraint itself the reason model-authored SQL could never be
-- Verified: run_exploratory_sql had to borrow the source_exploration route, and
-- the finalizer rightly refuses Verified answers carrying that route. sql_first
-- is the third route: model-authored SQL over the canonical model whose
-- structure is linted before execution, whose claims are attested against
-- governed metric contracts after execution, and whose answer state derives
-- from the evidence tier of everything the statement touched. The audit row
-- shape is unchanged — ir stays a NOT NULL object and now carries the declared
-- claim envelope (purpose, normalised SQL digest, claims, window) instead of a
-- typed plan, and bundle_hash is keyed off that envelope.

BEGIN;

ALTER TABLE semantic_internal.query_audit
  DROP CONSTRAINT IF EXISTS query_audit_route_check;
ALTER TABLE semantic_internal.query_audit
  ADD CONSTRAINT query_audit_route_check
  CHECK (route IN ('semantic','source_exploration','sql_first'));

COMMIT;
