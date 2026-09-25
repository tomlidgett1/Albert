BEGIN;

-- `database_lock_timeout` is a bounded, code-only retry reason emitted by the
-- sync worker when PostgreSQL cancels a statement while it waits for a lock.
-- Migration 0058 is checksum-immutable, so extend its validator in a new
-- migration instead of rewriting history.
CREATE OR REPLACE FUNCTION control_plane.sync_failure_code_valid_0058(p_code text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT p_code IN (
    'authentication_required',
    'backfill_completion_evidence_missing',
    'backfill_continuation_requires_stream',
    'backfill_plan_requires_coordinator',
    'backfill_phase_requires_stream',
    'backfill_successor_requires_stream',
    'capability_unavailable',
    'configuration_invalid',
    'connection_account_mismatch',
    'connection_generation_stale',
    'connection_not_ready',
    'connector_page_invalid_pagination_block',
    'connector_page_missing_continuation_cursor',
    'connector_page_non_advancing_cursor',
    'connector_stream_not_found',
    'credential_conflict',
    'cursor_invalid',
    'database_deadlock',
    'database_integrity_violation',
    'database_lock_timeout',
    'database_permission_denied',
    'database_serialization_conflict',
    'database_unavailable',
    'incremental_sync_requires_stream',
    'oauth_exchange_failed',
    'rate_limited',
    'reconnect_modified_watermark_missing',
    'reconciliation_snapshot_failed',
    'reconciliation_snapshot_incomplete',
    'remote_response_invalid',
    'remote_unavailable',
    'sync_analytical_capability_invalid',
    'sync_internal_error',
    'sync_operation_timeout',
    'sync_stream_phase_lease_stale',
    'sync_write_permit_invalid',
    'sync_write_permit_missing',
    'unexpected_sync_failure',
    'webhook_signature_invalid'
  )
$$;

COMMIT;
