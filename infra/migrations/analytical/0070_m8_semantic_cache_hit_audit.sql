BEGIN;

ALTER TABLE semantic_internal.query_audit
  ADD COLUMN IF NOT EXISTS cache_hit boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN semantic_internal.query_audit.cache_hit IS
  'True when a governed result cache satisfied this access. Every cache hit still receives its own immutable audit row and current quality validation.';

COMMIT;
