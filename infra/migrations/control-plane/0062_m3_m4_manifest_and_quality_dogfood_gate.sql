BEGIN;

-- Table-stat projections made by a candidate transform carry the exact quality
-- run that produced their invariant map and the source snapshot's complete
-- table inventory. Hourly maintenance projections leave all four attestation
-- fields NULL and are useful operationally, but cannot attest a release.
ALTER TABLE control_plane.pipeline_stats
  ADD COLUMN IF NOT EXISTS quality_run_id text,
  ADD COLUMN IF NOT EXISTS quality_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_table_count integer,
  ADD COLUMN IF NOT EXISTS snapshot_inventory_hash text;
ALTER TABLE control_plane.pipeline_stats
  DROP CONSTRAINT IF EXISTS pipeline_stats_quality_attestation_valid;
ALTER TABLE control_plane.pipeline_stats
  ADD CONSTRAINT pipeline_stats_quality_attestation_valid CHECK (
    (quality_run_id IS NULL AND quality_checked_at IS NULL
      AND snapshot_table_count IS NULL AND snapshot_inventory_hash IS NULL)
    OR
    (quality_run_id IS NOT NULL
      AND control_plane.is_ulid(quality_run_id)
      AND quality_checked_at IS NOT NULL
      AND snapshot_table_count IS NOT NULL AND snapshot_table_count>0
      AND snapshot_inventory_hash IS NOT NULL
      AND snapshot_inventory_hash ~ '^[0-9a-f]{64}$')
  ) NOT VALID;
ALTER TABLE control_plane.pipeline_stats
  VALIDATE CONSTRAINT pipeline_stats_quality_attestation_valid;

-- Protected acceptance must be tied to the reviewed connector packs, not to
-- whichever subset of streams happens to have rows in the operational tables.
-- This catalogue is deliberately release-owned and has a static contract test
-- against the TypeScript manifests.
CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_stream_expectation (
  connector_key text NOT NULL CHECK (connector_key IN ('lightspeed-r','xero','deputy')),
  pack_version text NOT NULL CHECK (
    pack_version ~ '^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?$'
  ),
  api_version text NOT NULL CHECK (length(btrim(api_version))>0),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  required boolean NOT NULL,
  backfill_strategy text NOT NULL CHECK (
    backfill_strategy IN ('time_windowed','snapshot','exhaustive_offset')
  ),
  domains text[] NOT NULL CHECK (control_plane.product_domain_array_valid(domains)),
  dependencies text[] NOT NULL CHECK (
    control_plane.stream_dependency_array_valid(stream,dependencies)
  ),
  late_edit_strategy text NOT NULL CHECK (
    late_edit_strategy IN ('modified_field','full_snapshot','append_only')
  ),
  deletion_strategy text NOT NULL CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan',
      'immutable_append_only'
    )
  ),
  source_total_strategy text NOT NULL CHECK (
    source_total_strategy IN ('provider_reported','count_distinct_complete_scan')
  ),
  PRIMARY KEY (connector_key,stream)
);

INSERT INTO control_plane.protected_dogfood_stream_expectation(
  connector_key,pack_version,api_version,stream,required,backfill_strategy,
  domains,dependencies,late_edit_strategy,deletion_strategy,source_total_strategy
) VALUES
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','shops',true,'snapshot',ARRAY['inventory','products','sales']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','employees',true,'snapshot',ARRAY['sales']::text[],ARRAY['shops']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','categories',true,'snapshot',ARRAY['inventory','products','sales']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','items',true,'snapshot',ARRAY['inventory','products','sales']::text[],ARRAY['categories']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','item_shops',true,'snapshot',ARRAY['inventory']::text[],ARRAY['items','shops']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','sales',true,'time_windowed',ARRAY['customers','sales']::text[],ARRAY['customers','employees','items','payment_types','shops','tax_categories']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','customers',true,'snapshot',ARRAY['customers']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','vendors',true,'snapshot',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','orders',true,'time_windowed',ARRAY['inventory']::text[],ARRAY['employees','items','shops','vendors']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','order_lines',true,'time_windowed',ARRAY['inventory']::text[],ARRAY['items','orders']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','payment_types',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','tax_categories',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','1.1.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','inventory_logs',false,'time_windowed',ARRAY['inventory']::text[],ARRAY['items','shops']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','organisation',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','accounts',true,'snapshot',ARRAY['accounting']::text[],ARRAY['organisation']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','contacts',true,'snapshot',ARRAY['accounting']::text[],ARRAY['organisation']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','invoices',true,'time_windowed',ARRAY['accounting']::text[],ARRAY['accounts','contacts','organisation','tax_rates','tracking_categories']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','credit_notes',true,'time_windowed',ARRAY['accounting']::text[],ARRAY['accounts','contacts','organisation','tax_rates','tracking_categories']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','payments',true,'time_windowed',ARRAY['accounting']::text[],ARRAY['accounts','contacts','organisation']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','bank_transactions',true,'time_windowed',ARRAY['accounting']::text[],ARRAY['accounts','organisation','tax_rates','tracking_categories']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','manual_journals',true,'time_windowed',ARRAY['accounting']::text[],ARRAY['accounts','organisation','tax_rates','tracking_categories']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','journals',false,'exhaustive_offset',ARRAY['accounting']::text[],ARRAY['accounts','organisation','tax_rates','tracking_categories']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','tax_rates',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','1.0.0','Accounting API 2.0; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026)','tracking_categories',true,'snapshot',ARRAY['accounting']::text[],ARRAY['organisation']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','companies',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','operational_units',true,'snapshot',ARRAY['workforce']::text[],ARRAY['companies']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','employees',true,'snapshot',ARRAY['workforce']::text[],ARRAY['companies','operational_units']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','rosters',true,'time_windowed',ARRAY['workforce']::text[],ARRAY['companies','employees','operational_units']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','timesheets',true,'time_windowed',ARRAY['workforce']::text[],ARRAY['companies','employees','operational_units']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','leave',true,'time_windowed',ARRAY['workforce']::text[],ARRAY['companies','employees','operational_units']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','contacts',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan')
ON CONFLICT (connector_key,stream) DO UPDATE SET
  pack_version=excluded.pack_version,
  api_version=excluded.api_version,
  required=excluded.required,
  backfill_strategy=excluded.backfill_strategy,
  domains=excluded.domains,
  dependencies=excluded.dependencies,
  late_edit_strategy=excluded.late_edit_strategy,
  deletion_strategy=excluded.deletion_strategy,
  source_total_strategy=excluded.source_total_strategy;

-- The control-plane projection must contain this exact reviewed quality set,
-- all passed. New analytical checks intentionally fail the release gate until
-- this migration-owned expectation is reviewed and advanced.
CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_quality_expectation (
  check_id text PRIMARY KEY CHECK (check_id ~ '^[a-z][a-z0-9_]*$')
);

INSERT INTO control_plane.protected_dogfood_quality_expectation(check_id) VALUES
  ('canonical_mapping_total'),
  ('cost_coverage'),
  ('currency_consistency'),
  ('cursor_completeness'),
  ('delete_handling'),
  ('enum_drift'),
  ('field_coverage_vs_manifest'),
  ('journal_balances'),
  ('labour_cost_coverage'),
  ('line_maths'),
  ('no_orphan_observations'),
  ('observation_coverage'),
  ('orphan_rate'),
  ('pk_unique'),
  ('pos_bank_tolerance'),
  ('pos_ledger_tolerance'),
  ('posting_bridge_coverage'),
  ('retention_limit_recorded'),
  ('schema_drift'),
  ('scope_available'),
  ('settlement_bridge_coverage'),
  ('shift_timesheet_coverage'),
  ('status_mapping_total'),
  ('stock_continuity'),
  ('tax_consistency'),
  ('tender_reconciles'),
  ('tz_validity'),
  ('webhook_gap_recovered')
ON CONFLICT(check_id) DO NOTHING;

CREATE OR REPLACE FUNCTION control_plane.assert_protected_dogfood_manifest_and_quality(
  p_tenant_id text,
  p_connections jsonb,
  p_barrier_at timestamptz
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE latest_snapshot timestamptz;
DECLARE required_quality jsonb;
DECLARE quality_run_min text;
DECLARE quality_run_max text;
DECLARE quality_checked_min timestamptz;
DECLARE quality_checked_max timestamptz;
DECLARE declared_table_count_min integer;
DECLARE declared_table_count_max integer;
DECLARE declared_inventory_hash_min text;
DECLARE declared_inventory_hash_max text;
DECLARE actual_table_count integer;
DECLARE actual_inventory_hash text;
DECLARE candidate_evidence_at timestamptz;
BEGIN
  IF p_tenant_id IS NULL
     OR NOT control_plane.is_ulid(p_tenant_id)
     OR p_barrier_at IS NULL
     OR p_barrier_at>clock_timestamp()
     OR jsonb_typeof(p_connections) IS DISTINCT FROM 'object'
     OR NOT (p_connections ?& ARRAY['lightspeed-r','xero','deputy'])
     OR p_connections-ARRAY['lightspeed-r','xero','deputy']<>'{}'::jsonb
     OR EXISTS (
       SELECT 1 FROM jsonb_each_text(p_connections) item
        WHERE control_plane.is_ulid(item.value) IS DISTINCT FROM true
     ) THEN
    RAISE EXCEPTION 'protected dogfood manifest gate input is invalid' USING ERRCODE='22023';
  END IF;

  -- The selectors must still identify the current generation of each exact
  -- connector. This also prevents a stale plan from another authorization
  -- epoch satisfying the inventory checks below.
  IF (SELECT count(*)
        FROM jsonb_each_text(p_connections) selected(connector_key,connection_id)
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=selected.connection_id
         AND connection.connector_key=selected.connector_key
         AND connection.connection_generation>0)<>3 THEN
    RAISE EXCEPTION 'protected dogfood connector generations are incomplete' USING ERRCODE='55000';
  END IF;

  -- Reject both missing and unreviewed extra streams for the selected current
  -- generations. An attacker cannot turn a one-stream sync into M3 evidence.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM control_plane.sync_stream_phases phase
      JOIN selected USING(connection_id,connection_generation)
      LEFT JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
       AND expected.stream=phase.stream
     WHERE phase.tenant_id=p_tenant_id
       AND expected.stream IS NULL
  ) OR EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
      LEFT JOIN LATERAL (
        SELECT count(*) AS phase_count,
               array_agg(phase.phase ORDER BY phase.phase_ordinal) AS phases,
               array_agg(phase.phase_ordinal ORDER BY phase.phase_ordinal) AS ordinals,
               array_agg(phase.range_from ORDER BY phase.phase_ordinal) AS range_froms,
               array_agg(phase.range_to ORDER BY phase.phase_ordinal) AS range_tos,
               bool_and(phase.required=expected.required) AS requirement_matches,
               bool_and(phase.backfill_strategy=expected.backfill_strategy) AS strategy_matches,
               bool_and(phase.domains=expected.domains) AS domains_match,
               bool_and(phase.dependencies=expected.dependencies) AS dependencies_match,
               bool_and(phase.dependency_plan_sealed) AS dependency_plan_is_sealed,
               bool_and(
                 phase.predecessor_phase IS NOT DISTINCT FROM CASE phase.phase
                   WHEN 'recent' THEN NULL
                   WHEN 'thirteen_months' THEN 'recent'
                   ELSE 'thirteen_months'
                 END
               ) AS predecessor_matches,
               bool_and(
                 phase.plan_mode=CASE
                   WHEN expected.backfill_strategy='time_windowed' THEN 'progressive'
                   ELSE 'single_pass'
                 END
               ) AS mode_matches
          FROM control_plane.sync_stream_phases phase
         WHERE phase.tenant_id=p_tenant_id
           AND phase.connection_id=selected.connection_id
           AND phase.connection_generation=selected.connection_generation
           AND phase.stream=expected.stream
      ) plan ON true
     WHERE NOT coalesce(plan.requirement_matches,false)
        OR NOT coalesce(plan.strategy_matches,false)
        OR NOT coalesce(plan.domains_match,false)
        OR NOT coalesce(plan.dependencies_match,false)
        OR NOT coalesce(plan.dependency_plan_is_sealed,false)
        OR NOT coalesce(plan.predecessor_matches,false)
        OR NOT coalesce(plan.mode_matches,false)
        OR CASE WHEN expected.backfill_strategy='time_windowed'
             THEN plan.phase_count<>3
               OR plan.phases<>ARRAY['recent','thirteen_months','full_history']::text[]
               OR plan.ordinals<>ARRAY[1,2,3]::smallint[]
               OR plan.range_froms[1]<>plan.range_tos[2]
               OR plan.range_froms[2]<>plan.range_tos[3]
             ELSE plan.phase_count<>1
               OR plan.phases<>ARRAY['recent']::text[]
               OR plan.ordinals<>ARRAY[1]::smallint[]
           END
  ) THEN
    RAISE EXCEPTION 'dogfood stream plan does not match the exact reviewed connector manifests'
      USING ERRCODE='55000';
  END IF;

  -- Immutable raw evidence from the selected current generations must itself
  -- be release-exact. Requiring one matching batch is insufficient when an
  -- additional batch proves that unreviewed connector/API/stream code also ran.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.raw_batch_manifests manifest
        ON manifest.tenant_id=p_tenant_id
       AND manifest.connection_id=selected.connection_id
      JOIN control_plane.sync_runs run
        ON run.tenant_id=manifest.tenant_id
       AND run.sync_run_id=manifest.sync_run_id
       AND run.connection_generation=selected.connection_generation
      LEFT JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
       AND expected.stream=manifest.stream
     WHERE (manifest.created_at>=p_barrier_at OR manifest.extracted_at>=p_barrier_at)
       AND (
         expected.stream IS NULL
         OR manifest.connector_key IS DISTINCT FROM selected.connector_key
         OR manifest.connector_version IS DISTINCT FROM expected.pack_version
         OR manifest.api_version IS DISTINCT FROM expected.api_version
         OR run.connection_id IS DISTINCT FROM selected.connection_id
         OR run.stream IS DISTINCT FROM manifest.stream
       )
  ) THEN
    RAISE EXCEPTION 'dogfood raw manifests do not match the exact reviewed connector release'
      USING ERRCODE='55000';
  END IF;

  -- Required streams must all succeed on the candidate. Optional streams may
  -- be explicitly unavailable, but only with durable capability evidence and
  -- no failed/in-flight phase hidden behind that outcome.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
      JOIN LATERAL (
        SELECT bool_and(phase.status='succeeded' AND phase.completed_at>=p_barrier_at)
                 AS all_succeeded,
               bool_or(
                 phase.status='unavailable'
                 AND phase.completed_at>=p_barrier_at
                 AND phase.last_error->>'code'='capability_unavailable'
               ) AS has_evidenced_unavailable,
               bool_and(
                 phase.status IN ('succeeded','unavailable','planned')
                 AND CASE WHEN phase.status IN ('succeeded','unavailable')
                      THEN phase.completed_at>=p_barrier_at ELSE true END
               ) AS optional_terminal
          FROM control_plane.sync_stream_phases phase
         WHERE phase.tenant_id=p_tenant_id
           AND phase.connection_id=selected.connection_id
           AND phase.connection_generation=selected.connection_generation
           AND phase.stream=expected.stream
      ) state ON true
     WHERE CASE WHEN expected.required
            THEN NOT coalesce(state.all_succeeded,false)
            ELSE NOT (
              coalesce(state.all_succeeded,false)
              OR (
                coalesce(state.has_evidenced_unavailable,false)
                AND coalesce(state.optional_terminal,false)
              )
            )
          END
  ) THEN
    RAISE EXCEPTION 'dogfood stream phases are not terminal under the reviewed availability policy'
      USING ERRCODE='55000';
  END IF;

  -- Every fully available stream must have candidate-era raw, cursor and
  -- reconciliation evidence. Optional streams stopped by an explicit
  -- capability_unavailable result are the only exception.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
     WHERE NOT EXISTS (
       SELECT 1
         FROM control_plane.sync_stream_phases unavailable
        WHERE unavailable.tenant_id=p_tenant_id
          AND unavailable.connection_id=selected.connection_id
          AND unavailable.connection_generation=selected.connection_generation
          AND unavailable.stream=expected.stream
          AND unavailable.status='unavailable'
          AND unavailable.completed_at>=p_barrier_at
          AND unavailable.last_error->>'code'='capability_unavailable'
     )
       AND (
         NOT EXISTS (
           SELECT 1
             FROM control_plane.raw_batch_manifests manifest
             JOIN control_plane.raw_batch_landings landing
               ON landing.tenant_id=manifest.tenant_id
              AND landing.batch_id=manifest.batch_id
             JOIN control_plane.sync_runs run
               ON run.tenant_id=manifest.tenant_id
              AND run.sync_run_id=manifest.sync_run_id
            WHERE manifest.tenant_id=p_tenant_id
              AND manifest.connection_id=selected.connection_id
              AND manifest.connector_key=selected.connector_key
              AND manifest.connector_version=expected.pack_version
              AND manifest.api_version=expected.api_version
              AND manifest.stream=expected.stream
              AND manifest.created_at>=p_barrier_at
              AND manifest.extracted_at>=p_barrier_at
              AND run.connection_id=selected.connection_id
              AND run.stream=expected.stream
              AND run.connection_generation=selected.connection_generation
              AND run.status='succeeded'
              AND run.finished_at>=p_barrier_at
              AND landing.status='landed'
              AND landing.analytical_committed_at>=p_barrier_at
         )
         OR NOT EXISTS (
           SELECT 1
             FROM control_plane.stream_cursors cursor_row
            WHERE cursor_row.tenant_id=p_tenant_id
              AND cursor_row.connection_id=selected.connection_id
              AND cursor_row.connection_generation=selected.connection_generation
              AND cursor_row.stream=expected.stream
              AND cursor_row.backfill_complete
              AND cursor_row.last_successful_sync_at>=p_barrier_at
         )
         OR NOT EXISTS (
           SELECT 1
             FROM control_plane.reconciliation_stream_sweeps sweep
            WHERE sweep.tenant_id=p_tenant_id
              AND sweep.connection_id=selected.connection_id
              AND sweep.connection_generation=selected.connection_generation
              AND sweep.stream=expected.stream
              AND sweep.required=expected.required
              AND sweep.connector_id=selected.connector_key
              AND cardinality(sweep.domains)=cardinality(expected.domains)
              AND ARRAY(
                SELECT domain_name.value
                  FROM unnest(sweep.domains) AS domain_name(value)
                 ORDER BY domain_name.value
              )=expected.domains
              AND sweep.late_edit_strategy=expected.late_edit_strategy
              AND sweep.deletion_strategy=expected.deletion_strategy
              AND sweep.source_total_strategy=expected.source_total_strategy
              AND sweep.status='complete'
              AND sweep.completed_at>=p_barrier_at
              AND NOT EXISTS (
                SELECT 1
                  FROM control_plane.reconciliation_stream_sweeps newer
                 WHERE newer.tenant_id=sweep.tenant_id
                   AND newer.connection_id=sweep.connection_id
                   AND newer.connection_generation=sweep.connection_generation
                   AND newer.stream=sweep.stream
                   AND (newer.created_at,newer.reconciliation_sweep_id)>
                       (sweep.created_at,sweep.reconciliation_sweep_id)
              )
         )
       )
  ) THEN
    RAISE EXCEPTION 'dogfood manifest streams lack candidate raw, cursor or reconciliation evidence'
      USING ERRCODE='55000';
  END IF;

  -- A complete quality map is only candidate evidence when its oldest check
  -- and its snapshot were produced after the final terminal/raw/cursor/sweep
  -- observation for the full reviewed inventory. An explicitly unavailable
  -- optional stream contributes its terminal phase time but, by policy, no
  -- fabricated raw/cursor/reconciliation evidence.
  WITH selected AS (
    SELECT item.key AS connector_key,item.value AS connection_id,
           connection.connection_generation
      FROM jsonb_each_text(p_connections) item
      JOIN control_plane.connections connection
        ON connection.tenant_id=p_tenant_id
       AND connection.connection_id=item.value
       AND connection.connector_key=item.key
  ), available AS (
    SELECT selected.*,expected.stream,expected.pack_version,expected.api_version,
           expected.required,expected.domains,expected.late_edit_strategy,
           expected.deletion_strategy,expected.source_total_strategy
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
     WHERE NOT EXISTS (
       SELECT 1
         FROM control_plane.sync_stream_phases unavailable
        WHERE unavailable.tenant_id=p_tenant_id
          AND unavailable.connection_id=selected.connection_id
          AND unavailable.connection_generation=selected.connection_generation
          AND unavailable.stream=expected.stream
          AND unavailable.status='unavailable'
          AND unavailable.completed_at>=p_barrier_at
          AND unavailable.last_error->>'code'='capability_unavailable'
     )
  ), evidence(evidence_at) AS (
    SELECT phase.completed_at
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
      JOIN control_plane.sync_stream_phases phase
        ON phase.tenant_id=p_tenant_id
       AND phase.connection_id=selected.connection_id
       AND phase.connection_generation=selected.connection_generation
       AND phase.stream=expected.stream
     WHERE phase.status IN ('succeeded','unavailable')
       AND phase.completed_at>=p_barrier_at
    UNION ALL
    SELECT greatest(
             manifest.created_at,manifest.extracted_at,run.finished_at,
             landing.analytical_committed_at
           )
      FROM available
      JOIN control_plane.raw_batch_manifests manifest
        ON manifest.tenant_id=p_tenant_id
       AND manifest.connection_id=available.connection_id
       AND manifest.connector_key=available.connector_key
       AND manifest.connector_version=available.pack_version
       AND manifest.api_version=available.api_version
       AND manifest.stream=available.stream
      JOIN control_plane.raw_batch_landings landing
        ON landing.tenant_id=manifest.tenant_id
       AND landing.batch_id=manifest.batch_id
      JOIN control_plane.sync_runs run
        ON run.tenant_id=manifest.tenant_id
       AND run.sync_run_id=manifest.sync_run_id
       AND run.connection_id=available.connection_id
       AND run.connection_generation=available.connection_generation
       AND run.stream=available.stream
     WHERE manifest.created_at>=p_barrier_at
       AND manifest.extracted_at>=p_barrier_at
       AND run.status='succeeded'
       AND run.finished_at>=p_barrier_at
       AND landing.status='landed'
       AND landing.analytical_committed_at>=p_barrier_at
    UNION ALL
    SELECT cursor_row.last_successful_sync_at
      FROM available
      JOIN control_plane.stream_cursors cursor_row
        ON cursor_row.tenant_id=p_tenant_id
       AND cursor_row.connection_id=available.connection_id
       AND cursor_row.connection_generation=available.connection_generation
       AND cursor_row.stream=available.stream
     WHERE cursor_row.backfill_complete
       AND cursor_row.last_successful_sync_at>=p_barrier_at
    UNION ALL
    SELECT greatest(sweep.created_at,sweep.completed_at)
      FROM available
      JOIN control_plane.reconciliation_stream_sweeps sweep
        ON sweep.tenant_id=p_tenant_id
       AND sweep.connection_id=available.connection_id
       AND sweep.connection_generation=available.connection_generation
       AND sweep.stream=available.stream
       AND sweep.required=available.required
       AND sweep.connector_id=available.connector_key
       AND cardinality(sweep.domains)=cardinality(available.domains)
       AND ARRAY(
         SELECT domain_name.value
           FROM unnest(sweep.domains) AS domain_name(value)
          ORDER BY domain_name.value
       )=available.domains
       AND sweep.late_edit_strategy=available.late_edit_strategy
       AND sweep.deletion_strategy=available.deletion_strategy
       AND sweep.source_total_strategy=available.source_total_strategy
     WHERE sweep.status='complete'
       AND sweep.completed_at>=p_barrier_at
       AND NOT EXISTS (
         SELECT 1
           FROM control_plane.reconciliation_stream_sweeps newer
          WHERE newer.tenant_id=sweep.tenant_id
            AND newer.connection_id=sweep.connection_id
            AND newer.connection_generation=sweep.connection_generation
            AND newer.stream=sweep.stream
            AND (newer.created_at,newer.reconciliation_sweep_id)>
                (sweep.created_at,sweep.reconciliation_sweep_id)
       )
  )
  SELECT max(evidence_at) INTO candidate_evidence_at FROM evidence;

  SELECT max(stat.snapshot_at) INTO latest_snapshot
    FROM control_plane.pipeline_stats stat
   WHERE stat.tenant_id=p_tenant_id
     AND stat.snapshot_at>=p_barrier_at
     AND stat.snapshot_at<=clock_timestamp()
     AND stat.created_at>=p_barrier_at
     AND stat.created_at<=clock_timestamp();
  SELECT jsonb_object_agg(expected.check_id,'passed' ORDER BY expected.check_id)
    INTO required_quality
    FROM control_plane.protected_dogfood_quality_expectation expected;
  SELECT min(stat.quality_run_id),max(stat.quality_run_id),
         min(stat.quality_checked_at),max(stat.quality_checked_at),
         min(stat.snapshot_table_count),max(stat.snapshot_table_count),
         min(stat.snapshot_inventory_hash),max(stat.snapshot_inventory_hash)
    INTO quality_run_min,quality_run_max,quality_checked_min,quality_checked_max,
         declared_table_count_min,declared_table_count_max,
         declared_inventory_hash_min,declared_inventory_hash_max
    FROM control_plane.pipeline_stats stat
   WHERE stat.tenant_id=p_tenant_id
     AND stat.snapshot_at=latest_snapshot;

  SELECT count(*)::integer,
         encode(extensions.digest(convert_to(
           jsonb_agg(
             jsonb_build_array(stat.schema_name,stat.table_name)
             ORDER BY stat.schema_name COLLATE "C",stat.table_name COLLATE "C"
           )::text,
           'UTF8'
         ),'sha256'),'hex')
    INTO actual_table_count,actual_inventory_hash
    FROM control_plane.pipeline_stats stat
   WHERE stat.tenant_id=p_tenant_id
     AND stat.snapshot_at=latest_snapshot;

  IF latest_snapshot IS NOT NULL AND (
       declared_table_count_min IS NULL
       OR declared_table_count_min IS DISTINCT FROM declared_table_count_max
       OR declared_table_count_min IS DISTINCT FROM actual_table_count
       OR declared_inventory_hash_min IS NULL
       OR declared_inventory_hash_min IS DISTINCT FROM declared_inventory_hash_max
       OR declared_inventory_hash_min IS DISTINCT FROM actual_inventory_hash
       OR EXISTS (
         SELECT 1
           FROM control_plane.pipeline_stats stat
          WHERE stat.tenant_id=p_tenant_id
            AND stat.snapshot_at=latest_snapshot
            AND (
              stat.snapshot_table_count IS DISTINCT FROM declared_table_count_min
              OR stat.snapshot_inventory_hash IS DISTINCT FROM declared_inventory_hash_min
            )
       )
     ) THEN
    RAISE EXCEPTION 'dogfood pipeline snapshot inventory is incomplete or substituted'
      USING ERRCODE='55000';
  END IF;

  IF latest_snapshot IS NULL
     OR candidate_evidence_at IS NULL
     OR candidate_evidence_at>clock_timestamp()
     OR latest_snapshot<candidate_evidence_at
     OR required_quality IS NULL
     OR quality_run_min IS NULL
     OR quality_run_min IS DISTINCT FROM quality_run_max
     OR quality_checked_min IS NULL
     OR quality_checked_min IS DISTINCT FROM quality_checked_max
     OR quality_checked_min<p_barrier_at
     OR quality_checked_min<candidate_evidence_at
     OR quality_checked_min>clock_timestamp()
     OR latest_snapshot<quality_checked_min
     OR EXISTS (
    SELECT 1
      FROM control_plane.pipeline_stats stat
     WHERE stat.tenant_id=p_tenant_id
       AND stat.snapshot_at=latest_snapshot
       AND (
         stat.created_at<p_barrier_at
         OR stat.created_at<candidate_evidence_at
         OR stat.created_at>clock_timestamp()
         OR stat.invariant_status IS DISTINCT FROM required_quality
         OR stat.quality_run_id IS DISTINCT FROM quality_run_min
         OR stat.quality_checked_at IS DISTINCT FROM quality_checked_min
       )
  ) OR NOT EXISTS (
    SELECT 1 FROM control_plane.pipeline_stats stat
     WHERE stat.tenant_id=p_tenant_id AND stat.snapshot_at=latest_snapshot
  ) OR NOT EXISTS (
    SELECT 1
      FROM control_plane.sync_runs run
      JOIN jsonb_each_text(p_connections) selected(connector_key,connection_id)
        ON selected.connection_id=run.connection_id
      JOIN control_plane.connections connection
        ON connection.tenant_id=run.tenant_id
       AND connection.connection_id=run.connection_id
       AND connection.connector_key=selected.connector_key
       AND connection.connection_generation=run.connection_generation
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
       AND expected.stream=run.stream
      JOIN control_plane.raw_batch_manifests manifest
        ON manifest.tenant_id=run.tenant_id
       AND manifest.sync_run_id=run.sync_run_id
       AND manifest.connection_id=run.connection_id
       AND manifest.connector_key=selected.connector_key
       AND manifest.connector_version=expected.pack_version
       AND manifest.api_version=expected.api_version
       AND manifest.stream=run.stream
      JOIN control_plane.raw_batch_landings landing
        ON landing.tenant_id=manifest.tenant_id
       AND landing.batch_id=manifest.batch_id
     WHERE run.tenant_id=p_tenant_id
       AND run.sync_run_id=quality_run_min
       AND run.status='succeeded'
       AND run.finished_at>=p_barrier_at
       AND run.finished_at<=clock_timestamp()
       AND manifest.created_at>=p_barrier_at
       AND manifest.created_at<=clock_timestamp()
       AND manifest.extracted_at>=p_barrier_at
       AND manifest.extracted_at<=clock_timestamp()
       AND landing.status='landed'
       AND landing.analytical_committed_at>=p_barrier_at
       AND landing.analytical_committed_at<=clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'dogfood quality snapshot is not bound to the exact candidate-era passing check set'
      USING ERRCODE='55000';
  END IF;
END;
$$;

-- Keep the original collector as an inaccessible implementation detail. The
-- wrapper calls it first to preserve its detailed validation and append-only
-- snapshot construction; any new assertion failure aborts that insert in the
-- same statement and transaction.
ALTER FUNCTION control_plane.capture_protected_dogfood_acceptance(
  text,text,text,jsonb,text,integer,text,text,text,text,text
) RENAME TO capture_protected_dogfood_acceptance_v1;

CREATE FUNCTION control_plane.capture_protected_dogfood_acceptance(
  p_candidate_sha text,
  p_deployment_id text,
  p_dogfood_tenant_id text,
  p_connections jsonb,
  p_onboarding_tenant_id text,
  p_onboarding_target_minutes integer,
  p_flagship_answer_artifact_id text,
  p_category_answer_artifact_id text,
  p_category_topic text,
  p_disconnect_proof_id text,
  p_tenant_deletion_proof_id text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE snapshot jsonb;
DECLARE barrier_at timestamptz;
BEGIN
  snapshot:=control_plane.capture_protected_dogfood_acceptance_v1(
    p_candidate_sha,p_deployment_id,p_dogfood_tenant_id,p_connections,
    p_onboarding_tenant_id,p_onboarding_target_minutes,
    p_flagship_answer_artifact_id,p_category_answer_artifact_id,p_category_topic,
    p_disconnect_proof_id,p_tenant_deletion_proof_id
  );
  barrier_at:=(snapshot->'evidence'->'deployment'->>'barrierAt')::timestamptz;
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    p_dogfood_tenant_id,p_connections,barrier_at
  );
  RETURN snapshot;
END;
$$;

REVOKE ALL ON TABLE
  control_plane.protected_dogfood_stream_expectation,
  control_plane.protected_dogfood_quality_expectation
FROM PUBLIC,anon,authenticated,service_role,albert_operator_diagnostic_control;
REVOKE ALL ON TABLE
  control_plane.protected_dogfood_stream_expectation,
  control_plane.protected_dogfood_quality_expectation
FROM albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_deletion_control;
REVOKE ALL ON FUNCTION
  control_plane.assert_protected_dogfood_manifest_and_quality(text,jsonb,timestamptz),
  control_plane.capture_protected_dogfood_acceptance_v1(
    text,text,text,jsonb,text,integer,text,text,text,text,text
  ),
  control_plane.capture_protected_dogfood_acceptance(
    text,text,text,jsonb,text,integer,text,text,text,text,text
  )
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_deletion_control,albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.capture_protected_dogfood_acceptance(
  text,text,text,jsonb,text,integer,text,text,text,text,text
) TO albert_operator_diagnostic_control;

COMMIT;
