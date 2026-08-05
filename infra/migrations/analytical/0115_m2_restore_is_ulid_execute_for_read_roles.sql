-- 0108 hardened core.is_ulid(text) for the immutable canonical staging
-- envelopes introduced by 0106:
--
--   REVOKE ALL ON FUNCTION core.is_ulid(text) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION core.is_ulid(text) TO ingest_rw;
--
-- It granted the declared writer but did not restore the roles that had been
-- reaching the function through PUBLIC. semantic_ro lost it, so from the moment
-- 0108 applied every governed analytical query failed with
-- "permission denied for function is_ulid" (42501) and the chat could not
-- answer a single question -- the failure surfaced only as an opaque 503.
--
-- Restore execute to the read roles that held it before 0108. This is a
-- revert of the unintended half of that change, not a widening: EXECUTE on a
-- pure, immutable ULID-shape predicate grants no data access, and ingest_rw
-- keeps the access 0108 set out to give it.

BEGIN;

GRANT EXECUTE ON FUNCTION core.is_ulid(text)
  TO semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;

COMMENT ON FUNCTION core.is_ulid(text) IS
  'Immutable ULID shape predicate. Executable by every analytical runtime role: it is used inside tenant-scope guards on the read path as well as the staging CHECK constraints.';

COMMIT;
