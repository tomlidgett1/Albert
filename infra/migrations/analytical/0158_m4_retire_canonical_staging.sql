-- Completes the canonical retirement started in 0157. The sync worker no
-- longer writes canonical staging envelopes (the V3 semantic layer reads the
-- raw source_* tables directly through Cube), and nothing reads them. The
-- mart schema itself follows its tables out.

BEGIN;

DROP TABLE IF EXISTS ingestion.canonical_staging_batch_records CASCADE;
DROP SCHEMA IF EXISTS mart CASCADE;

DO $$
BEGIN
  IF to_regprocedure('core.current_tenant_id()') IS NULL
     OR to_regprocedure('core.is_ulid(text)') IS NULL
     OR to_regprocedure('core.is_currency(text)') IS NULL THEN
    RAISE EXCEPTION 'canonical staging retirement removed a retained core helper';
  END IF;
END $$;

COMMIT;
