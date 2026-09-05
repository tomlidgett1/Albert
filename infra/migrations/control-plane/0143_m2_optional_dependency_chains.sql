-- The dependency-plan sealer (0045) rejected any stream that depends on an
-- optional stream. That rule fit Lightspeed and Deputy, whose graphs are all
-- required, but Xero declares region- and tier-gated families (payroll AU/UK/
-- NZ, projects, assets, files) as availability='optional' and their child
-- streams depend on their optional parents: an AU organisation has no UK
-- payroll, so uk_payslip_earnings_lines -> uk_payslips -> uk_pay_runs are all
-- optional together. Eighty-eight such edges made every Xero InitialBackfill
-- fail at plan seal with 'sync dependency is missing or optional'.
--
-- The invariant that actually matters is that a REQUIRED stream never rests
-- on an optional one (a skipped parent would silently starve a required
-- child). An optional stream depending on an optional stream is sound: when
-- the parent is marked unavailable, the child is skipped with it. Dangling
-- dependencies (no planned phase at all) remain a hard error for everyone.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.seal_sync_dependency_plan(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE phase_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'sync-dependency-plan:'||p_tenant_id||':'||p_connection_id||':'||p_connection_generation,0
  ));
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.connections connection
     WHERE connection.tenant_id=p_tenant_id AND connection.connection_id=p_connection_id
       AND connection.connection_generation=p_connection_generation
       AND connection.status IN ('connected','degraded')
  ) THEN
    RAISE EXCEPTION 'sync dependency plan generation is stale' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
     WHERE phase_row.tenant_id=p_tenant_id
       AND phase_row.connection_id=p_connection_id
       AND phase_row.connection_generation=p_connection_generation
       AND phase_row.phase='recent'
  ) THEN
    RAISE EXCEPTION 'sync dependency plan has no recent phase' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
    CROSS JOIN LATERAL unnest(phase_row.dependencies) dependency
    LEFT JOIN control_plane.sync_stream_phases required_phase
      ON required_phase.tenant_id=phase_row.tenant_id
     AND required_phase.connection_id=phase_row.connection_id
     AND required_phase.connection_generation=phase_row.connection_generation
     AND required_phase.stream=dependency AND required_phase.phase='recent'
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND required_phase.stream IS NULL
  ) THEN
    RAISE EXCEPTION 'sync dependency is missing' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
    CROSS JOIN LATERAL unnest(phase_row.dependencies) dependency
    JOIN control_plane.sync_stream_phases required_phase
      ON required_phase.tenant_id=phase_row.tenant_id
     AND required_phase.connection_id=phase_row.connection_id
     AND required_phase.connection_generation=phase_row.connection_generation
     AND required_phase.stream=dependency AND required_phase.phase='recent'
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.required AND NOT required_phase.required
  ) THEN
    RAISE EXCEPTION 'required sync stream depends on an optional stream' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
    LEFT JOIN control_plane.sync_stream_phases recent_phase
      ON recent_phase.tenant_id=phase_row.tenant_id
     AND recent_phase.connection_id=phase_row.connection_id
     AND recent_phase.connection_generation=phase_row.connection_generation
     AND recent_phase.stream=phase_row.stream AND recent_phase.phase='recent'
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND (
       recent_phase.stream IS NULL OR phase_row.dependencies<>recent_phase.dependencies
       OR phase_row.domains<>recent_phase.domains OR phase_row.required<>recent_phase.required
       OR phase_row.backfill_strategy<>recent_phase.backfill_strategy
     )
  ) THEN
    RAISE EXCEPTION 'sync dependency metadata differs across stream phases' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    WITH RECURSIVE walk(root,current,path,cycle) AS (
      SELECT phase_row.stream,dependency,ARRAY[phase_row.stream,dependency],
             dependency=phase_row.stream
        FROM control_plane.sync_stream_phases phase_row
        CROSS JOIN LATERAL unnest(phase_row.dependencies) dependency
       WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
         AND phase_row.connection_generation=p_connection_generation
         AND phase_row.phase='recent'
      UNION ALL
      SELECT walk.root,next_dependency,walk.path||next_dependency,
             next_dependency=ANY(walk.path)
        FROM walk
        JOIN control_plane.sync_stream_phases next_phase
          ON next_phase.tenant_id=p_tenant_id AND next_phase.connection_id=p_connection_id
         AND next_phase.connection_generation=p_connection_generation
         AND next_phase.stream=walk.current AND next_phase.phase='recent'
        CROSS JOIN LATERAL unnest(next_phase.dependencies) next_dependency
       WHERE NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle
  ) THEN
    RAISE EXCEPTION 'sync dependency plan contains a cycle' USING ERRCODE='55000';
  END IF;

  UPDATE control_plane.sync_stream_phases
     SET dependency_plan_sealed=true
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation;
  GET DIAGNOSTICS phase_count=ROW_COUNT;
  INSERT INTO control_plane.progressive_stream_coverage(
    tenant_id,connection_id,connection_generation,stream,dependencies,
    product_domains,covered_from,covered_to,status,evidence
  )
  SELECT phase_row.tenant_id,phase_row.connection_id,phase_row.connection_generation,
         phase_row.stream,phase_row.dependencies,phase_row.domains,
         phase_row.range_from,phase_row.range_to,'pending',jsonb_build_object(
           'phase','recent','planMode',phase_row.plan_mode,
           'backfillStrategy',phase_row.backfill_strategy,
           'required',phase_row.required
         )
    FROM control_plane.sync_stream_phases phase_row
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.phase='recent'
  ON CONFLICT (tenant_id,connection_id,connection_generation,stream,phase) DO NOTHING;
  RETURN phase_count;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.seal_sync_dependency_plan(text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.seal_sync_dependency_plan(text,text,bigint)
  TO albert_sync_control;

-- Fail closed: the relaxed rule must still reject required->optional edges
-- and dangling dependencies, and must no longer reject optional->optional.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('control_plane.seal_sync_dependency_plan(text,text,bigint)'::regprocedure);
  IF def !~ 'required sync stream depends on an optional stream'
     OR def !~ 'sync dependency is missing'''
     OR def ~ 'sync dependency is missing or optional' THEN
    RAISE EXCEPTION 'optional dependency chain rule was not applied';
  END IF;
END $$;

COMMIT;
