BEGIN;

-- Item.tax is a taxable flag in live R-Series payloads (boolean), not money.
-- The original typed staging migration incorrectly treated it as numeric(19,4),
-- which quarantined every Ashburton item row during dogfood sync. The guarded
-- conversion keeps this migration replay-safe for the dogfood database, where
-- the emergency correction preceded its migration-ledger entry.
DO $$
DECLARE current_type text;
BEGIN
  SELECT data_type
    INTO current_type
    FROM information_schema.columns
   WHERE table_schema='source_lightspeed'
     AND table_name='items'
     AND column_name='tax';

  IF current_type IS NULL THEN
    RAISE EXCEPTION 'source_lightspeed.items.tax is missing';
  ELSIF current_type='boolean' THEN
    RETURN;
  ELSIF current_type<>'numeric' THEN
    RAISE EXCEPTION 'source_lightspeed.items.tax has unsupported type %',current_type;
  END IF;

  EXECUTE 'ALTER TABLE source_lightspeed.items ALTER COLUMN tax DROP DEFAULT';
  EXECUTE $conversion$
    ALTER TABLE source_lightspeed.items
      ALTER COLUMN tax TYPE boolean
      USING (
        CASE
          WHEN tax IS NULL THEN NULL
          WHEN tax = 0 THEN false
          WHEN tax = 1 THEN true
          ELSE NULL
        END
      )
  $conversion$;
END;
$$;

COMMIT;
