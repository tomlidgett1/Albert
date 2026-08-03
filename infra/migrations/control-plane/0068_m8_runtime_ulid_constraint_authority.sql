BEGIN;

-- Runtime DML is checked against ULID-constrained columns. PostgreSQL evaluates
-- CHECK expressions with the caller's function privileges, so the constrained
-- service groups need this one immutable predicate even when every table grant
-- is otherwise correct. No role receives access to a mutating or row-reading
-- routine here.
REVOKE ALL ON FUNCTION control_plane.is_ulid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.is_ulid(text) TO
  albert_sync_control,
  albert_webhook_control,
  albert_transform_control,
  albert_semantic_control,
  albert_operator_diagnostic_control,
  albert_deletion_control,
  albert_vendor_connection_attestor;

COMMIT;
