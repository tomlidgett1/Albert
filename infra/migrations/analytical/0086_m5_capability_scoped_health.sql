BEGIN;

-- Topic health must follow the exact capability contributors selected for the
-- answer. A tenant-global connector roll-up makes an unrelated source failure
-- (for example Xero while answering Lightspeed sales) poison every Topic.
CREATE OR REPLACE FUNCTION quality.current_scoped_health(
  p_tenant_id text,
  p_domains text[],
  p_capabilities text[]
) RETURNS TABLE (
  check_id text,
  domain text,
  status text,
  details jsonb,
  checked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,core,quality,semantic_internal
AS $$
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
        FROM semantic_internal.tenant_capability capability
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
      SELECT capability,connection_id,connector_id,stream
        FROM authority_scoped
       WHERE is_authoritative OR NOT has_configured_authority
    ), contributors AS (
      SELECT DISTINCT connection_id,connector_id,stream
        FROM capability_contributors
    ), capability_coverage AS (
      SELECT count(*)::integer AS requested_count,
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
    ), observed AS (
      SELECT expected.check_id,expected.max_age,
             contributor.connection_id,contributor.connector_id,contributor.stream,
             latest.status AS observed_status,latest.details AS observed_details,
             latest.checked_at AS observed_at
        FROM expected
        LEFT JOIN contributors contributor ON true
        LEFT JOIN LATERAL (
          SELECT observation.status,observation.details,observation.checked_at
            FROM quality.connector_check_observation observation
           WHERE observation.tenant_id=p_tenant_id
             AND observation.connection_id=contributor.connection_id
             AND observation.connector_id=contributor.connector_id
             AND observation.stream=contributor.stream
             AND observation.check_id=expected.check_id
           ORDER BY observation.checked_at DESC,observation.run_id DESC,
                    observation.batch_id DESC LIMIT 1
        ) latest ON true
    )
    SELECT observed.check_id,'connector'::text,
           CASE
             WHEN capability_coverage.represented_count<>capability_coverage.requested_count
               OR count(observed.connection_id)=0
               OR bool_or(observed.observed_status IS NULL)
               OR bool_or(observed.observed_at<now()-observed.max_age)
               OR bool_or(observed.observed_status='blocked') THEN 'blocked'
             WHEN bool_or(observed.observed_status='failed') THEN 'failed'
             WHEN bool_or(observed.observed_status='warning') THEN 'warning'
             ELSE 'passed'
           END,
           jsonb_build_object(
             'reason_code','capability_scoped_connector_health',
             'requested_capabilities',to_jsonb(p_capabilities),
             'represented_capability_count',capability_coverage.represented_count,
             'missing_capabilities',capability_coverage.missing,
             'contributor_count',count(observed.connection_id),
             'contributors',coalesce(jsonb_agg(jsonb_build_object(
               'connection_id',observed.connection_id,
               'connector_id',observed.connector_id,
               'stream',observed.stream,
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
$$;

REVOKE ALL ON FUNCTION quality.current_scoped_health(text,text[],text[])
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.current_scoped_health(text,text[],text[])
  TO semantic_ro,transform_rw,diagnostic_ro;

COMMIT;
