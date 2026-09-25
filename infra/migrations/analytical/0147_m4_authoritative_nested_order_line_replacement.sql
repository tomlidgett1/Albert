-- A connector can observe an order and its complete mutable child collection
-- in one source record (Square Order is the first example). When a later
-- authoritative version removes a child, retaining the old canonical line
-- overstates sales. Give line observations the same effective-interval
-- semantics already used by order observations so the transform can close the
-- prior source evidence and safely reopen it if the child later reappears.

BEGIN;

ALTER TABLE core.order_line_source_observation
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL
    DEFAULT '1970-01-01T00:00:00Z'::timestamptz,
  ADD COLUMN IF NOT EXISTS valid_to timestamptz;

-- PostgreSQL installs this immutable constant default without a row rewrite on
-- supported production versions. Existing observations become one open
-- interval from the canonical epoch; new transform writes use their observed
-- source instant explicitly.

ALTER TABLE core.order_line_source_observation
  DROP CONSTRAINT IF EXISTS order_line_source_observation_valid_interval_check;
ALTER TABLE core.order_line_source_observation
  ADD CONSTRAINT order_line_source_observation_valid_interval_check
  CHECK (valid_to IS NULL OR valid_to > valid_from) NOT VALID;
ALTER TABLE core.order_line_source_observation
  VALIDATE CONSTRAINT order_line_source_observation_valid_interval_check;

-- Preserve every historical observation interval. A partial unique index
-- separately guarantees that only one interval is current for a native line.
DO $do$
DECLARE
  v_primary_key text;
BEGIN
  SELECT constraint_name
    INTO v_primary_key
    FROM information_schema.table_constraints
   WHERE table_schema='core'
     AND table_name='order_line_source_observation'
     AND constraint_type='PRIMARY KEY';

  IF v_primary_key IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM information_schema.key_column_usage
     WHERE table_schema='core'
       AND table_name='order_line_source_observation'
       AND constraint_name=v_primary_key
       AND column_name='valid_from'
  ) THEN
    EXECUTE format(
      'ALTER TABLE core.order_line_source_observation DROP CONSTRAINT %I',
      v_primary_key
    );
    v_primary_key := NULL;
  END IF;

  IF v_primary_key IS NULL THEN
    ALTER TABLE core.order_line_source_observation
      ADD CONSTRAINT order_line_source_observation_pkey PRIMARY KEY (
        tenant_id,order_line_id,connection_id,source_object_type,
        source_record_id,source_line_ref,valid_from
      );
  END IF;
END
$do$;

CREATE UNIQUE INDEX IF NOT EXISTS order_line_source_observation_one_current
  ON core.order_line_source_observation (
    tenant_id,order_line_id,connection_id,source_object_type,
    source_record_id,source_line_ref
  )
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS order_line_source_observation_current_order_idx
  ON core.order_line_source_observation (tenant_id,order_line_id,connection_id)
  WHERE valid_to IS NULL;

COMMENT ON COLUMN core.order_line_source_observation.valid_from IS
  'Inclusive start of this authoritative source-observation interval.';
COMMENT ON COLUMN core.order_line_source_observation.valid_to IS
  'Exclusive end set when an authoritative parent version removes the line.';

COMMIT;
