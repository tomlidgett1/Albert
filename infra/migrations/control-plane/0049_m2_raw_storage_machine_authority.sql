BEGIN;

-- The administrator stream owns managed Auth references and Storage policies.
-- Seal that structural authority into the checksummed application migration
-- history before any session-credential runtime can be released.
SELECT extensions.albert_verify_raw_storage_machine_authority();

DO $$
BEGIN
  IF has_function_privilege(
    'albert_control_migration_owner',
    'extensions.albert_verify_raw_storage_machine_authority()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'raw Storage authority verifier did not self-revoke';
  END IF;
  IF has_function_privilege(
    'service_role',
    'extensions.albert_raw_storage_machine_authorized(text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role must not enter the raw Storage policy boundary';
  END IF;
END;
$$;

COMMIT;
