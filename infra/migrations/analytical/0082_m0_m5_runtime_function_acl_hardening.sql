BEGIN;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, and
-- CREATE OR REPLACE preserves the previous ACL. The analytical cell has no
-- public function surface: every runtime call is explicitly granted to one
-- fixed NOLOGIN group after review.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
  ingestion,source_lightspeed,source_xero,source_deputy,
  core,mart,quality,semantic_internal,deletion_internal
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION quality.run_all_invariants(text,text)
FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.run_all_invariants(text,text)
TO transform_rw;

-- Make the fail-closed default durable for every later migration-owned
-- function. Individual migrations must grant an exact signature deliberately.
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner
  IN SCHEMA ingestion,source_lightspeed,source_xero,source_deputy,
            core,mart,quality,semantic_internal,deletion_internal
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
