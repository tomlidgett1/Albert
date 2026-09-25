-- A bounded reconciliation scan can prove late edits without proving that an
-- identity absent from the window was deleted. Keep this distinct from the
-- genuinely immutable append-only policy so mutable connector streams retain
-- their modified-field/full-snapshot reconciliation semantics.

BEGIN;

ALTER TABLE control_plane.reconciliation_stream_sweeps
  DROP CONSTRAINT IF EXISTS reconciliation_stream_sweeps_deletion_strategy_check;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  ADD CONSTRAINT reconciliation_stream_sweeps_deletion_strategy_check CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan',
      'no_absence_deletes','immutable_append_only'
    )
  );

ALTER TABLE control_plane.reconciliation_stream_sweeps
  DROP CONSTRAINT IF EXISTS reconciliation_stream_sweeps_source_total_strategy_check;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  ADD CONSTRAINT reconciliation_stream_sweeps_source_total_strategy_check CHECK (
    source_total_strategy IN (
      'provider_reported','count_distinct_complete_scan','count_distinct_bounded_scan'
    )
  );
ALTER TABLE control_plane.reconciliation_stream_sweeps
  DROP CONSTRAINT IF EXISTS reconciliation_stream_sweeps_authoritative_total_check;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  ADD CONSTRAINT reconciliation_stream_sweeps_authoritative_total_check CHECK (
    deletion_strategy<>'authoritative_identity_scan'
    OR source_total_strategy<>'count_distinct_bounded_scan'
  );

ALTER TABLE control_plane.protected_dogfood_stream_expectation
  DROP CONSTRAINT IF EXISTS protected_dogfood_stream_expectation_deletion_strategy_check;
ALTER TABLE control_plane.protected_dogfood_stream_expectation
  ADD CONSTRAINT protected_dogfood_stream_expectation_deletion_strategy_check CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan',
      'no_absence_deletes','immutable_append_only'
    )
  );

ALTER TABLE control_plane.protected_dogfood_stream_expectation
  DROP CONSTRAINT IF EXISTS protected_dogfood_stream_expectation_source_total_strategy_check;
ALTER TABLE control_plane.protected_dogfood_stream_expectation
  ADD CONSTRAINT protected_dogfood_stream_expectation_source_total_strategy_check CHECK (
    source_total_strategy IN (
      'provider_reported','count_distinct_complete_scan','count_distinct_bounded_scan'
    )
  );
ALTER TABLE control_plane.protected_dogfood_stream_expectation
  DROP CONSTRAINT IF EXISTS protected_dogfood_stream_expectation_authoritative_total_check;
ALTER TABLE control_plane.protected_dogfood_stream_expectation
  ADD CONSTRAINT protected_dogfood_stream_expectation_authoritative_total_check CHECK (
    deletion_strategy<>'authoritative_identity_scan'
    OR source_total_strategy<>'count_distinct_bounded_scan'
  );

-- Reproduce the latest registration function from 0086 with only the two
-- policy vocabularies widened. Durable conflict checks remain exact: a sweep
-- cannot change its coverage or deletion semantics mid-flight.
CREATE OR REPLACE FUNCTION control_plane.register_reconciliation_stream(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_reconciliation_sweep_id text,
  p_connector_id text,
  p_stream text,
  p_required boolean,
  p_domains text[],
  p_late_edit_strategy text,
  p_deletion_strategy text,
  p_source_total_strategy text,
  p_lookback_from timestamptz,
  p_lookback_to timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE existing control_plane.reconciliation_stream_sweeps%ROWTYPE;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_reconciliation_sweep_id)
     OR p_connection_generation < 1
     OR NOT control_plane.is_known_connector(p_connector_id)
     OR p_stream !~ '^[a-z][a-z0-9_]*$'
     OR coalesce(cardinality(p_domains),0)=0
     OR p_late_edit_strategy NOT IN ('modified_field','full_snapshot','append_only')
     OR p_deletion_strategy NOT IN (
       'soft_delete','verified_delete_feed','authoritative_identity_scan',
       'no_absence_deletes','immutable_append_only'
     )
     OR p_source_total_strategy NOT IN (
       'provider_reported','count_distinct_complete_scan','count_distinct_bounded_scan'
     )
     OR (
       p_deletion_strategy='authoritative_identity_scan'
       AND p_source_total_strategy='count_distinct_bounded_scan'
     )
     OR p_lookback_from > p_lookback_to
     OR (p_deletion_strategy='immutable_append_only' AND p_late_edit_strategy<>'append_only') THEN
    RAISE EXCEPTION 'reconciliation stream registration is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.connections connection
     WHERE connection.tenant_id=p_tenant_id
       AND connection.connection_id=p_connection_id
       AND connection.connector_key=p_connector_id
       AND connection.connection_generation=p_connection_generation
       AND connection.status IN ('connected','degraded')
  ) THEN
    RAISE EXCEPTION 'reconciliation connection generation is stale' USING ERRCODE='55000';
  END IF;

  SELECT * INTO existing
    FROM control_plane.reconciliation_stream_sweeps
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation
     AND reconciliation_sweep_id=p_reconciliation_sweep_id AND stream=p_stream
   FOR UPDATE;
  IF FOUND THEN
    IF existing.connector_id<>p_connector_id OR existing.required<>p_required
       OR existing.domains<>p_domains
       OR existing.late_edit_strategy<>p_late_edit_strategy
       OR existing.deletion_strategy<>p_deletion_strategy
       OR existing.source_total_strategy<>p_source_total_strategy
       OR existing.lookback_from<>p_lookback_from OR existing.lookback_to<>p_lookback_to THEN
      RAISE EXCEPTION 'reconciliation stream registration conflicts with durable plan'
        USING ERRCODE='55000';
    END IF;
    RETURN;
  END IF;

  INSERT INTO control_plane.reconciliation_stream_sweeps (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,
    connector_id,stream,required,domains,late_edit_strategy,deletion_strategy,
    source_total_strategy,lookback_from,lookback_to
  ) VALUES (
    p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,
    p_connector_id,p_stream,p_required,p_domains,p_late_edit_strategy,p_deletion_strategy,
    p_source_total_strategy,p_lookback_from,p_lookback_to
  );
END;
$$;

COMMIT;
