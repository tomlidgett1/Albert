BEGIN;

DO $$
DECLARE
  source_relation regclass := to_regclass('quality.reconciliation_snapshot');
  lookup_relation regclass := to_regclass('quality.reconciliation_snapshot_status_lookup');
  source_status_attnum smallint;
  lookup_status_attnum smallint;
  actual_statuses text[];
BEGIN
  IF source_relation IS NULL OR lookup_relation IS NULL THEN
    RAISE EXCEPTION 'reconciliation snapshot lifecycle lookup relation is missing';
  END IF;

  SELECT attribute.attnum::smallint
    INTO source_status_attnum
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid=source_relation
     AND attribute.attname='status'
     AND NOT attribute.attisdropped;
  SELECT attribute.attnum::smallint
    INTO lookup_status_attnum
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid=lookup_relation
     AND attribute.attname='value'
     AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid=source_relation
       AND constraint_row.conname='reconciliation_snapshot_status_fkey'
       AND constraint_row.contype='f'
       AND constraint_row.confrelid=lookup_relation
       AND constraint_row.conkey=ARRAY[source_status_attnum]::smallint[]
       AND constraint_row.confkey=ARRAY[lookup_status_attnum]::smallint[]
       AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'validated reconciliation snapshot status foreign key is missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid=source_relation
       AND constraint_row.conname='reconciliation_snapshot_status_check'
       AND constraint_row.contype='c'
  ) THEN
    RAISE EXCEPTION 'legacy reconciliation snapshot literal status check still exists';
  END IF;

  SELECT array_agg(value ORDER BY value)
    INTO actual_statuses
    FROM quality.reconciliation_snapshot_status_lookup;
  IF actual_statuses IS NULL
     OR actual_statuses <> ARRAY['complete','failed','running']::text[] THEN
    RAISE EXCEPTION 'reconciliation snapshot lifecycle lookup has unexpected values';
  END IF;
END;
$$;

ROLLBACK;
