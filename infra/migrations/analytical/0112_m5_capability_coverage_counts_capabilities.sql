-- Every connector check was reported blocked for this tenant while its only
-- contributor stream was passed. The capability-coverage guard counts rows
-- from a LEFT JOIN, not requested capabilities:
--
--   FROM requested_capability requested
--   LEFT JOIN capability_contributors contributor USING (capability)
--   -> count(*) AS requested_count
--
-- capability_contributors holds one row per (capability, connection, stream),
-- so a capability observed by two contributor rows makes requested_count 2
-- while represented_count stays 1, and the represented<>requested arm forces
-- blocked. commerce.order_lines has exactly two such rows, so activating the
-- Lightspeed pack turned every governed answer Unavailable with
-- missing_capabilities: [].
--
-- Count distinct requested capabilities, which is what the guard means: every
-- requested capability must have at least one authoritative contributor. The
-- rest of the function, including every real blocked/failed/warning arm, is
-- byte-identical to the installed definition.

BEGIN;

CREATE OR REPLACE FUNCTION quality.current_scoped_health(p_tenant_id text, p_domains text[], p_capabilities text[])
 RETURNS TABLE(check_id text, domain text, status text, details jsonb, checked_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'quality', 'semantic_internal'
AS $function$
DECLARE non_connector_domains text[];
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_domains),0)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_domains) value
     WHERE value !~ '^[a-z][a-z0-9_.-]{0,99}$'
  ) OR coalesce(cardinality(p_capabilities),0)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_capabilities) value
     WHERE value !~ '^[a-z][a-z0-9_.]{0,119}$'
  ) THEN
    RAISE EXCEPTION 'scoped health inputs are invalid' USING ERRCODE='22023';
  END IF;

  IF 'connector'=ANY(p_domains) THEN
    RETURN QUERY
    WITH requested_capability AS (
      SELECT DISTINCT value AS capability FROM unnest(p_capabilities) value
    ), candidates AS (
      SELECT capability.capability,capability.connection_id,capability.connector_id,
             capability.coverage->>'stream' AS stream,capability.evaluated_at,
             CASE
               WHEN capability.capability LIKE 'inventory.%' THEN 'stock'
               WHEN capability.capability LIKE 'workforce.shifts%' THEN 'planned_shifts'
               WHEN capability.capability LIKE 'workforce.%' THEN 'worked_hours'
               WHEN capability.capability IN ('finance.bank_transactions','finance.payments')
                 THEN 'cash_settlement'
               WHEN capability.capability LIKE 'finance.%' THEN 'statutory_finance'
               WHEN capability.capability='commerce.orders.customer' THEN 'customer_master'
               ELSE 'operational_sales'
             END AS authority_concept
        FROM semantic_internal.active_tenant_capability capability
        JOIN requested_capability requested USING (capability)
       WHERE capability.tenant_id=p_tenant_id AND capability.available
         AND capability.connection_id IS NOT NULL
         AND capability.coverage->>'stream' ~ '^[a-z][a-z0-9_]*$'
    ), authority_scoped AS (
      SELECT candidate.*,
             EXISTS (
               SELECT 1 FROM core.source_authority authority
                WHERE authority.tenant_id=p_tenant_id
                  AND authority.concept=candidate.authority_concept
                  AND authority.authoritative_connection_id=candidate.connection_id
                  AND authority.effective_from<=now()
                  AND (authority.effective_to IS NULL OR authority.effective_to>now())
             ) AS is_authoritative,
             EXISTS (
               SELECT 1 FROM core.source_authority authority
                WHERE authority.tenant_id=p_tenant_id
                  AND authority.concept=candidate.authority_concept
                  AND authority.effective_from<=now()
                  AND (authority.effective_to IS NULL OR authority.effective_to>now())
             ) AS has_configured_authority
        FROM candidates candidate
    ), capability_contributors AS (
      SELECT capability,connection_id,connector_id,stream,evaluated_at
        FROM authority_scoped
       WHERE is_authoritative OR NOT has_configured_authority
    ), contributors AS (
      SELECT connection_id,connector_id,stream,max(evaluated_at) AS capability_evaluated_at
        FROM capability_contributors
       GROUP BY connection_id,connector_id,stream
    ), capability_coverage AS (
      SELECT count(DISTINCT requested.capability)::integer AS requested_count,
             count(DISTINCT contributor.capability)::integer AS represented_count,
             coalesce(jsonb_agg(requested.capability ORDER BY requested.capability)
               FILTER (WHERE contributor.capability IS NULL),'[]'::jsonb) AS missing
        FROM requested_capability requested
        LEFT JOIN capability_contributors contributor
          ON contributor.capability=requested.capability
    ), expected AS (
      SELECT expectation.check_id,expectation.max_age
        FROM quality.check_expectation expectation
       WHERE expectation.domain='connector' AND expectation.required
    ), current_state AS (
      SELECT DISTINCT ON (state.connection_id,state.connector_id,state.stream)
             state.*
        FROM quality.connector_stream_state state
        JOIN contributors contributor
          ON contributor.connection_id=state.connection_id
         AND contributor.connector_id=state.connector_id
         AND contributor.stream=state.stream
       WHERE state.tenant_id=p_tenant_id
       ORDER BY state.connection_id,state.connector_id,state.stream,
                state.connection_generation DESC
    ), observed AS (
      SELECT expected.check_id,expected.max_age,
             contributor.connection_id,contributor.connector_id,contributor.stream,
             state.connection_generation,
             CASE
               WHEN state.connection_id IS NULL OR state.observed_page_count=0
                 OR state.last_page_at IS NULL THEN 'blocked'
               WHEN expected.check_id IN (
                 'cursor_completeness','scope_available','retention_limit_recorded',
                 'schema_drift','enum_drift'
               ) AND state.last_page_at<now()-expected.max_age THEN 'blocked'
               WHEN expected.check_id='cursor_completeness' THEN CASE
                 WHEN state.cursor_complete AND state.cursor_chain_valid THEN 'passed'
                 ELSE 'blocked' END
               WHEN expected.check_id='scope_available' THEN 'passed'
               WHEN expected.check_id='retention_limit_recorded' THEN CASE
                 WHEN state.backfill_complete AND state.retention_evidence IS NOT NULL THEN 'passed'
                 WHEN state.backfill_complete THEN 'blocked'
                 ELSE 'warning' END
               WHEN expected.check_id='webhook_gap_recovered' THEN CASE
                 WHEN state.reconciliation_gap_count>0 THEN 'blocked'
                 WHEN state.reconciliation_completed_at IS NULL
                   OR state.reconciliation_completed_at<now()-expected.max_age THEN 'warning'
                 ELSE 'passed' END
               WHEN expected.check_id='delete_handling' THEN CASE
                 WHEN state.reconciliation_gap_count>0
                   OR (state.source_total IS NOT NULL AND state.local_live_total IS NOT NULL
                       AND state.source_total<>state.local_live_total) THEN 'blocked'
                 WHEN state.reconciliation_completed_at IS NULL
                   OR state.reconciliation_completed_at<now()-expected.max_age
                   OR state.source_total IS NULL OR state.local_live_total IS NULL THEN 'warning'
                 ELSE 'passed' END
               WHEN expected.check_id='schema_drift' THEN CASE
                 WHEN state.unresolved_schema_drift_count=0 THEN 'passed' ELSE 'blocked' END
               ELSE CASE
                 WHEN state.unresolved_enum_drift_count+state.unresolved_quarantine_count=0
                   THEN 'passed' ELSE 'blocked' END
             END AS observed_status,
             jsonb_build_object(
               'reason_code',CASE
                 WHEN state.connection_id IS NULL THEN 'durable_stream_state_missing'
                 WHEN state.observed_page_count=0 OR state.last_page_at IS NULL
                   THEN 'durable_stream_unobserved'
                 WHEN expected.check_id IN (
                   'cursor_completeness','scope_available','retention_limit_recorded',
                   'schema_drift','enum_drift'
                 ) AND state.last_page_at<now()-expected.max_age
                   THEN 'durable_stream_state_stale'
                 WHEN expected.check_id='retention_limit_recorded' AND NOT state.backfill_complete
                   THEN 'full_history_pending'
                 WHEN expected.check_id IN ('webhook_gap_recovered','delete_handling')
                   AND (state.reconciliation_completed_at IS NULL
                        OR state.reconciliation_completed_at<now()-expected.max_age)
                   THEN 'reconciliation_pending_or_stale'
                 ELSE 'durable_stream_check'
               END,
               'connection_generation',state.connection_generation,
               'observed_page_count',coalesce(state.observed_page_count,0),
               'cursor_complete',coalesce(state.cursor_complete,false),
               'cursor_chain_valid',coalesce(state.cursor_chain_valid,false),
               'backfill_complete',coalesce(state.backfill_complete,false),
               'retention_evidence_recorded',state.retention_evidence IS NOT NULL,
               'reconciliation_completed_at',state.reconciliation_completed_at,
               'reconciliation_gap_count',coalesce(state.reconciliation_gap_count,0),
               'source_total',state.source_total,
               'local_live_total',state.local_live_total,
               'unresolved_schema_drift',coalesce(state.unresolved_schema_drift_count,0),
               'unresolved_enum_or_quarantine',
                 coalesce(state.unresolved_enum_drift_count,0)
                 +coalesce(state.unresolved_quarantine_count,0)
             ) AS observed_details,
             CASE
               WHEN expected.check_id IN ('webhook_gap_recovered','delete_handling')
                 THEN coalesce(state.reconciliation_completed_at,state.last_page_at)
               ELSE state.last_page_at
             END AS observed_at
        FROM expected
        LEFT JOIN contributors contributor ON true
        LEFT JOIN current_state state
          ON state.connection_id=contributor.connection_id
         AND state.connector_id=contributor.connector_id
         AND state.stream=contributor.stream
    )
    SELECT observed.check_id,'connector'::text,
           CASE
             WHEN capability_coverage.represented_count<>capability_coverage.requested_count
               OR count(observed.connection_id)=0
               OR bool_or(observed.observed_status IS NULL)
               OR bool_or(observed.observed_status='blocked') THEN 'blocked'
             WHEN bool_or(observed.observed_status='failed') THEN 'failed'
             WHEN bool_or(observed.observed_status='warning') THEN 'warning'
             ELSE 'passed'
           END,
           jsonb_build_object(
             'reason_code','capability_scoped_durable_connector_health',
             'requested_capabilities',to_jsonb(p_capabilities),
             'represented_capability_count',capability_coverage.represented_count,
             'missing_capabilities',capability_coverage.missing,
             'contributor_count',count(observed.connection_id),
             'contributors',coalesce(jsonb_agg(jsonb_build_object(
               'connection_id',observed.connection_id,
               'connector_id',observed.connector_id,
               'stream',observed.stream,
               'connection_generation',observed.connection_generation,
               'status',coalesce(observed.observed_status,'blocked'),
               'checked_at',observed.observed_at,
               'details',coalesce(observed.observed_details,'{}'::jsonb)
             ) ORDER BY observed.connector_id,observed.connection_id,observed.stream)
             FILTER (WHERE observed.connection_id IS NOT NULL),'[]'::jsonb)
           ),
           max(observed.observed_at)
      FROM observed CROSS JOIN capability_coverage
     GROUP BY observed.check_id,capability_coverage.requested_count,
              capability_coverage.represented_count,capability_coverage.missing
     ORDER BY observed.check_id;
  END IF;

  non_connector_domains:=ARRAY(
    SELECT DISTINCT value FROM unnest(p_domains) value
     WHERE value<>'connector' ORDER BY value
  );
  IF cardinality(non_connector_domains)>0 THEN
    RETURN QUERY
    SELECT health.check_id,health.domain,health.status,health.details,health.checked_at
      FROM quality.current_health(p_tenant_id,non_connector_domains) health;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION quality.current_scoped_health(text,text[],text[])
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.current_scoped_health(text,text[],text[])
  TO semantic_ro,transform_rw,diagnostic_ro;

COMMIT;
