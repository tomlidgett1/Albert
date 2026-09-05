-- Deletion-speed repair: index every foreign-key reference to
-- ingestion.batch_manifests.
--
-- Deleting a connection's batch manifests fires a referential-integrity check
-- per deleted manifest against EVERY table whose foreign key targets
-- batch_manifests — 465 constraints at the time of writing, of which 463 had
-- no index on their referencing columns. Each check was a sequential scan, so
-- the first real disconnect purge (Xero, 334 manifests) burned through 150k+
-- scans and died on the worker's statement timeout, cycling forever with a
-- redacted unexpected_deletion_failure.
--
-- The index list is derived from the catalog — each constraint's actual
-- referencing columns in constraint order — not hand-maintained, so staging
-- tables added by future connector packs are covered by re-running the same
-- shape (and the typed-staging generator should learn to emit this index).

BEGIN;

DO $$
DECLARE target record; created integer := 0;
BEGIN
  FOR target IN
    SELECT
      child_ns.nspname AS schema_name,
      child.relname AS table_name,
      child.oid AS table_oid,
      (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(fk.conkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = k.attnum
      ) AS fk_columns
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE parent_ns.nspname = 'ingestion'
      AND parent.relname = 'batch_manifests'
      AND fk.contype = 'f'
    ORDER BY child_ns.nspname, child.relname
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = target.table_oid
        AND (
          SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(i.indkey[0:array_length(target.fk_columns, 1) - 1])
               WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = target.table_oid AND a.attnum = k.attnum
        )::text[] @> target.fk_columns
        AND (
          SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(i.indkey[0:array_length(target.fk_columns, 1) - 1])
               WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = target.table_oid AND a.attnum = k.attnum
        )::text[] <@ target.fk_columns
    ) THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
        left(target.table_name, 47) || '_batch_ref_idx',
        target.schema_name, target.table_name,
        (SELECT string_agg(quote_ident(c), ', ') FROM unnest(target.fk_columns) c)
      );
      created := created + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'created % batch-reference indexes', created;
END $$;

-- Fail closed: every batch_manifests foreign key must now have an index whose
-- leading columns are exactly the constraint's referencing columns (any
-- order among those leading positions).
DO $$
DECLARE offender text;
BEGIN
  SELECT string_agg(child_ns.nspname || '.' || child.relname, ', ') INTO offender
  FROM pg_constraint fk
  JOIN pg_class child ON child.oid = fk.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = fk.confrelid
  JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
  WHERE parent_ns.nspname = 'ingestion'
    AND parent.relname = 'batch_manifests'
    AND fk.contype = 'f'
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = child.oid
        AND (
          SELECT array_agg(a.attname::text)
          FROM unnest(i.indkey[0:cardinality(fk.conkey) - 1])
               WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = k.attnum
        )::text[] @> (
          SELECT array_agg(a.attname::text)
          FROM unnest(fk.conkey) k(attnum)
          JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = k.attnum
        )
    );
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'batch-manifest reference indexes missing on: %', offender;
  END IF;
END $$;

COMMIT;
