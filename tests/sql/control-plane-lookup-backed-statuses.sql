BEGIN;

DO $$
DECLARE
  lifecycle record;
  source_relation regclass;
  lookup_relation regclass;
  source_status_attnum smallint;
  lookup_status_attnum smallint;
  actual_statuses text[];
BEGIN
  FOR lifecycle IN
    SELECT *
    FROM (VALUES
      (
        'control_plane.identity_decision_projection_outbox',
        'identity_decision_projection_outbox_status_fkey',
        'identity_decision_projection_outbox_status_check',
        'control_plane.identity_decision_projection_status_lookup',
        'status',
        ARRAY['failed','queued','retry_wait','running','succeeded']::text[]
      ),
      (
        'control_plane.operator_diagnostic_reveal_outcomes',
        'operator_diagnostic_reveal_outcomes_status_fkey',
        'operator_diagnostic_reveal_outcomes_status_check',
        'control_plane.operator_diagnostic_reveal_outcome_status_lookup',
        'status',
        ARRAY['completed','failed']::text[]
      ),
      (
        'control_plane.reconciliation_stream_sweeps',
        'reconciliation_stream_sweeps_status_fkey',
        'reconciliation_stream_sweeps_status_check',
        'control_plane.reconciliation_stream_sweep_status_lookup',
        'status',
        ARRAY['blocked','complete','planned','running']::text[]
      ),
      (
        'control_plane.progressive_stream_coverage',
        'progressive_stream_coverage_status_fkey',
        'progressive_stream_coverage_status_check',
        'control_plane.progressive_stream_coverage_status_lookup',
        'status',
        ARRAY['degraded','pending','queryable','superseded']::text[]
      ),
      (
        'control_plane.tenant_deletion_receipts',
        'tenant_deletion_receipts_status_fkey',
        'tenant_deletion_receipts_status_check',
        'control_plane.deletion_request_status_lookup',
        'status',
        ARRAY[
          'awaiting_approval','cancelled','completed','failed','queued',
          'retry_wait','running','verifying'
        ]::text[]
      ),
      (
        'control_plane.shopify_compliance_inbox',
        'shopify_compliance_inbox_status_fkey',
        'shopify_compliance_inbox_status_check',
        'control_plane.shopify_compliance_inbox_status_lookup',
        'status',
        ARRAY['dispatched','unresolved']::text[]
      ),
      (
        'control_plane.shopify_privacy_cases',
        'shopify_privacy_cases_status_fkey',
        'shopify_privacy_cases_status_check',
        'control_plane.shopify_privacy_case_status_lookup',
        'status',
        ARRAY[
          'attention_required','awaiting_delivery','awaiting_operator_export',
          'completed','export_in_progress','queued','redaction_dispatched'
        ]::text[]
      ),
      (
        'control_plane.shopify_privacy_exports',
        'shopify_privacy_exports_status_fkey',
        'shopify_privacy_exports_status_check',
        'control_plane.shopify_privacy_export_status_lookup',
        'status',
        ARRAY['claimed','completed','expired','failed','requested']::text[]
      ),
      (
        'control_plane.shopifyql_query_executions',
        'shopifyql_query_executions_status_fkey',
        'shopifyql_query_executions_status_check',
        'control_plane.shopifyql_query_execution_status_lookup',
        'status',
        ARRAY[
          'failed','parse_error','reserved','response_rejected','succeeded'
        ]::text[]
      ),
      (
        'control_plane.shopify_admin_query_executions',
        'shopify_admin_query_executions_status_fkey',
        'shopify_admin_query_executions_status_check',
        'control_plane.shopify_admin_query_execution_status_lookup',
        'status',
        ARRAY['failed','reserved','response_rejected','succeeded']::text[]
      )
    ) AS contract(
      source_name,foreign_key_name,legacy_check_name,lookup_name,
      lookup_column,required_statuses
    )
  LOOP
    source_relation := to_regclass(lifecycle.source_name);
    lookup_relation := to_regclass(lifecycle.lookup_name);
    IF source_relation IS NULL OR lookup_relation IS NULL THEN
      RAISE EXCEPTION 'lookup status contract relation is missing: % -> %',
        lifecycle.source_name,lifecycle.lookup_name;
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
       AND attribute.attname::text=lifecycle.lookup_column
       AND NOT attribute.attisdropped;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid=source_relation
         AND constraint_row.conname=lifecycle.foreign_key_name
         AND constraint_row.contype='f'
         AND constraint_row.confrelid=lookup_relation
         AND constraint_row.conkey=ARRAY[source_status_attnum]::smallint[]
         AND constraint_row.confkey=ARRAY[lookup_status_attnum]::smallint[]
         AND constraint_row.convalidated
    ) THEN
      RAISE EXCEPTION 'validated lifecycle lookup foreign key is missing: %',
        lifecycle.foreign_key_name;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid=source_relation
         AND constraint_row.conname=lifecycle.legacy_check_name
         AND constraint_row.contype='c'
    ) THEN
      RAISE EXCEPTION 'legacy literal lifecycle check still exists: %',
        lifecycle.legacy_check_name;
    END IF;

    EXECUTE format(
      'SELECT array_agg(%1$I ORDER BY %1$I) FROM %2$s',
      lifecycle.lookup_column,lookup_relation
    ) INTO actual_statuses;
    IF actual_statuses IS NULL
       OR NOT (actual_statuses @> lifecycle.required_statuses) THEN
      RAISE EXCEPTION 'lookup % is missing required lifecycle values',
        lifecycle.lookup_name;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
