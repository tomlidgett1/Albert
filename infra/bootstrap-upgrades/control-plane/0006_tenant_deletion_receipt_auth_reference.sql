BEGIN;

-- Migration 0053 creates a post-bootstrap table that needs one Auth user
-- reference. Managed Supabase does not let Albert's isolated migration owner
-- inherit REFERENCES on auth.users. Expose only this exact no-argument
-- constraint installation and consume its grant in the same migration
-- transaction that creates the table.
DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'tenant deletion receipt Auth installation requires the protected postgres login';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'the managed Supabase Auth user directory is missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_install_tenant_deletion_receipt_auth_reference()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '10s'
AS $$
DECLARE
  receipt_table regclass;
  requested_by_column smallint;
  auth_user_id_column smallint;
  existing pg_constraint%ROWTYPE;
BEGIN
  receipt_table := to_regclass('control_plane.tenant_deletion_receipts');
  IF receipt_table IS NULL THEN
    RAISE EXCEPTION 'tenant deletion receipt table is missing';
  END IF;
  IF pg_get_userbyid(
    (SELECT class.relowner FROM pg_class AS class WHERE class.oid = receipt_table)
  ) <> 'albert_control_migration_owner' THEN
    RAISE EXCEPTION 'tenant deletion receipt table has an unexpected owner';
  END IF;
  SELECT attribute.attnum INTO STRICT requested_by_column
    FROM pg_attribute AS attribute
   WHERE attribute.attrelid = receipt_table
     AND attribute.attname = 'requested_by'
     AND attribute.atttypid = 'uuid'::regtype
     AND attribute.attnotnull
     AND NOT attribute.attisdropped;
  SELECT attribute.attnum INTO STRICT auth_user_id_column
    FROM pg_attribute AS attribute
   WHERE attribute.attrelid = 'auth.users'::regclass
     AND attribute.attname = 'id'
     AND NOT attribute.attisdropped;

  SELECT constraint_row.* INTO existing
    FROM pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = receipt_table
     AND constraint_row.conname = 'tenant_deletion_receipts_requested_by_fkey';
  IF FOUND THEN
    IF existing.contype <> 'f'
       OR existing.confrelid <> 'auth.users'::regclass
       OR existing.conkey <> ARRAY[requested_by_column]::smallint[]
       OR existing.confkey <> ARRAY[auth_user_id_column]::smallint[]
       OR existing.confdeltype <> 'c'
       OR existing.confupdtype <> 'a'
       OR existing.confmatchtype <> 's'
       OR existing.condeferrable
       OR existing.condeferred
       OR NOT existing.convalidated THEN
      RAISE EXCEPTION 'tenant deletion receipt Auth reference has an unexpected definition';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM pg_constraint AS other
       WHERE other.conrelid = receipt_table
         AND other.contype = 'f'
         AND other.conkey = ARRAY[requested_by_column]::smallint[]
    ) THEN
      RAISE EXCEPTION 'tenant deletion receipt has an unexpected Auth reference';
    END IF;
    ALTER TABLE control_plane.tenant_deletion_receipts
      ADD CONSTRAINT tenant_deletion_receipts_requested_by_fkey
      FOREIGN KEY (requested_by)
      REFERENCES auth.users(id)
      ON UPDATE NO ACTION
      ON DELETE CASCADE
      NOT DEFERRABLE;
  END IF;

  REVOKE EXECUTE ON FUNCTION
    extensions.albert_install_tenant_deletion_receipt_auth_reference()
    FROM albert_control_migration_owner;
END;
$$;

REVOKE ALL ON FUNCTION
  extensions.albert_install_tenant_deletion_receipt_auth_reference()
  FROM PUBLIC,anon,authenticated,service_role,
       albert_sync_control,albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control;
GRANT EXECUTE ON FUNCTION
  extensions.albert_install_tenant_deletion_receipt_auth_reference()
  TO albert_control_migration_owner;

-- An existing cell may have applied migration 0053 before this protected
-- administrator upgrade was introduced. Repair that exact upgrade order now;
-- the installer validates the table shape and consumes its own grant.
DO $$
BEGIN
  IF to_regclass('albert_migrations.applied_migration') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM albert_migrations.applied_migration
       WHERE stream = 'control-plane'
         AND migration_id = '0053_m8_user_bound_tenant_deletion_receipts.sql'
    ) THEN
      PERFORM extensions.albert_install_tenant_deletion_receipt_auth_reference();
    END IF;
  END IF;
END;
$$;

COMMIT;
