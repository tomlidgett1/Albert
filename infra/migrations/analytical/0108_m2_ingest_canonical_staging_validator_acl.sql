BEGIN;

-- 0106 made ingest_rw the only writer of immutable canonical staging
-- envelopes. Their ULID CHECK constraints invoke core.is_ulid(text), whose
-- hardened ACL previously allowed transform_rw but not the declared writer.
REVOKE ALL ON FUNCTION core.is_ulid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.is_ulid(text) TO ingest_rw;

COMMIT;
