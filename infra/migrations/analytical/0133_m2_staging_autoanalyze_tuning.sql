-- 0133_m2_staging_autoanalyze_tuning.sql
--
-- Semantic-layer queries over the Lightspeed staging tables are dominated by
-- "recent period" predicates (last N days/months). These tables are
-- append-heavy: fresh rows always land past the end of the create_time /
-- ingested_at histograms, so with the default autovacuum_analyze_scale_factor
-- (0.1) the planner can believe a recent window matches ~1 row until 10% of
-- the table has churned. That underestimate flips joins to nested loops that
-- re-scan the joined staging subquery per row (observed: 0.9s query running
-- for 500s under RLS).
--
-- Lowering the per-table analyze trigger keeps histogram tails close to the
-- ingestion frontier. Applies to every current and future-safe staging table
-- in source_lightspeed (new tables must repeat this in their own migration).

BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
      FROM pg_tables
     WHERE schemaname = 'source_lightspeed'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500)',
      r.schemaname, r.tablename
    );
  END LOOP;
END $$;

-- Refresh statistics immediately so the fix takes effect without waiting for
-- the next autovacuum cycle.
ANALYZE;

COMMIT;
