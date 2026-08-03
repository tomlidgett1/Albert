\set ON_ERROR_STOP on

-- Exercise the reversible identity graph in PostgreSQL rather than merely
-- matching migration text. Everything is rolled back so the harness is safe to
-- rerun against the CI database.
BEGIN;

CREATE ROLE albert_identity_test_runtime
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT transform_rw TO albert_identity_test_runtime;

-- Seed a cache row as the administrative test identity. The first real graph
-- transition must invalidate it through the SECURITY DEFINER boundary.
INSERT INTO semantic_internal.result_cache (
  tenant_id,bundle_hash,registry_version,response,expires_at
) VALUES (
  '01H00000000000000000000901',repeat('a',64),'identity-test-v1',
  '{"state":"verified","provenance":{}}'::jsonb,now()+interval '1 hour'
);

-- Run fixture writes and decisions as a constrained runtime login. This makes
-- apply_identity_decision's session_user membership check executable in CI.
SET SESSION AUTHORIZATION albert_identity_test_runtime;
SET ROLE transform_rw;
SET LOCAL albert.tenant_id = '01H00000000000000000000901';

INSERT INTO core.location (
  tenant_id,id,name,timezone,sync_run_id
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000981',
  'Identity harness location','Australia/Melbourne','01H00000000000000000000941'
);

INSERT INTO core.worker (
  tenant_id,id,display_name,sync_run_id
) VALUES
  ('01H00000000000000000000901','01H00000000000000000000911','Worker A','01H00000000000000000000941'),
  ('01H00000000000000000000901','01H00000000000000000000912','Worker B','01H00000000000000000000941'),
  ('01H00000000000000000000901','01H00000000000000000000913','Worker C','01H00000000000000000000941');

INSERT INTO core.entity_source_link (
  tenant_id,link_id,entity_type,canonical_entity_id,connection_id,
  source_object_type,source_record_id,match_method,match_status,
  confidence_band,evidence,valid_from,sync_run_id
) VALUES
  (
    '01H00000000000000000000901','01H00000000000000000000931','worker',
    '01H00000000000000000000911','01H00000000000000000000921',
    'Employee','employee-a','external_id','accepted','high','{}'::jsonb,
    '1970-01-01T00:00:00Z','01H00000000000000000000941'
  ),
  (
    '01H00000000000000000000901','01H00000000000000000000932','worker',
    '01H00000000000000000000912','01H00000000000000000000922',
    'Employee','employee-b','external_id','accepted','high','{}'::jsonb,
    '1970-01-01T00:00:00Z','01H00000000000000000000941'
  ),
  (
    '01H00000000000000000000901','01H00000000000000000000933','worker',
    '01H00000000000000000000913','01H00000000000000000000923',
    'Employee','employee-c','external_id','accepted','high','{}'::jsonb,
    '1970-01-01T00:00:00Z','01H00000000000000000000941'
  );

-- A-B acceptance creates the first graph state, resolves both native anchors to
-- A, and clears the pre-existing semantic result cache.
DO $$
DECLARE
  candidates jsonb := jsonb_build_array(
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000911',
      'connection_id','01H00000000000000000000921',
      'source_object_type','Employee','source_record_id','employee-a','label','Worker A'
    ),
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000912',
      'connection_id','01H00000000000000000000922',
      'source_object_type','Employee','source_record_id','employee-b','label','Worker B'
    )
  );
  result jsonb;
BEGIN
  result := semantic_internal.apply_identity_decision(
    '01H00000000000000000000901','01H00000000000000000000951',
    '01H00000000000000000000961',1,'accepted','worker',candidates,
    '00000000-0000-4000-8000-000000000001','2026-08-03T00:00:00Z'
  );
  IF result->>'applied' IS DISTINCT FROM 'true'
     OR result->>'replayed' IS DISTINCT FROM 'false'
     OR (result->>'identityGraphVersion')::bigint IS DISTINCT FROM 1
     OR (result->>'cacheRowsInvalidated')::bigint IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'A-B acceptance returned unexpected metadata: %',result;
  END IF;
  IF (SELECT resolved_entity_id FROM core.entity_resolution
      WHERE tenant_id='01H00000000000000000000901' AND entity_type='worker'
        AND member_entity_id='01H00000000000000000000911')
       IS DISTINCT FROM '01H00000000000000000000911'
     OR (SELECT resolved_entity_id FROM core.entity_resolution
         WHERE tenant_id='01H00000000000000000000901' AND entity_type='worker'
           AND member_entity_id='01H00000000000000000000912')
       IS DISTINCT FROM '01H00000000000000000000911' THEN
    RAISE EXCEPTION 'A-B acceptance did not build the expected component';
  END IF;
END;
$$;

-- A fact arriving after the merge keeps B's physical source-owned foreign key.
-- A second C fact lets the governed aggregation prove transitive grouping.
INSERT INTO core.workforce_time_entry (
  tenant_id,id,worker_id,location_id,starts_at,ends_at,approved_at,
  business_date,status,worked_minutes,overtime_minutes,labour_cost,currency,
  primary_connection_id,primary_source_record_id,sync_run_id
) VALUES
  (
    '01H00000000000000000000901','01H00000000000000000000971',
    '01H00000000000000000000912','01H00000000000000000000981',
    '2026-08-03T09:00:00Z','2026-08-03T10:00:00Z','2026-08-03T10:00:00Z',
    '2026-08-03','approved',60,0,60,'AUD','01H00000000000000000000922',
    'time-entry-b','01H00000000000000000000941'
  ),
  (
    '01H00000000000000000000901','01H00000000000000000000972',
    '01H00000000000000000000913','01H00000000000000000000981',
    '2026-08-03T10:00:00Z','2026-08-03T10:30:00Z','2026-08-03T10:30:00Z',
    '2026-08-03','approved',30,0,30,'AUD','01H00000000000000000000923',
    'time-entry-c','01H00000000000000000000941'
  );

DO $$
DECLARE
  candidates jsonb := jsonb_build_array(
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000911',
      'connection_id','01H00000000000000000000921',
      'source_object_type','Employee','source_record_id','employee-a','label','Worker A'
    ),
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000912',
      'connection_id','01H00000000000000000000922',
      'source_object_type','Employee','source_record_id','employee-b','label','Worker B'
    )
  );
  result jsonb;
BEGIN
  result := semantic_internal.apply_identity_decision(
    '01H00000000000000000000901','01H00000000000000000000951',
    '01H00000000000000000000961',1,'accepted','worker',candidates,
    '00000000-0000-4000-8000-000000000001','2026-08-03T00:00:00Z'
  );
  IF result->>'replayed' IS DISTINCT FROM 'true'
     OR result->>'applied' IS DISTINCT FROM 'false'
     OR (result->>'identityGraphVersion')::bigint IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'exact replay was not an idempotent no-op: %',result;
  END IF;
END;
$$;

-- B-C acceptance creates a transitive A-B-C component without touching the
-- physical fact keys. The semantic-layer grouping resolves both rows to A.
DO $$
DECLARE
  candidates jsonb := jsonb_build_array(
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000912',
      'connection_id','01H00000000000000000000922',
      'source_object_type','Employee','source_record_id','employee-b','label','Worker B'
    ),
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000913',
      'connection_id','01H00000000000000000000923',
      'source_object_type','Employee','source_record_id','employee-c','label','Worker C'
    )
  );
  result jsonb;
  aggregate_rows integer;
  aggregate_worker text;
  aggregate_minutes bigint;
BEGIN
  result := semantic_internal.apply_identity_decision(
    '01H00000000000000000000901','01H00000000000000000000952',
    '01H00000000000000000000962',1,'accepted','worker',candidates,
    '00000000-0000-4000-8000-000000000001','2026-08-03T00:00:01Z'
  );
  IF result->>'applied' IS DISTINCT FROM 'true'
     OR (result->>'identityGraphVersion')::bigint IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'B-C acceptance returned unexpected metadata: %',result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM core.entity_resolution
    WHERE tenant_id='01H00000000000000000000901' AND entity_type='worker'
      AND member_entity_id IN (
        '01H00000000000000000000911','01H00000000000000000000912',
        '01H00000000000000000000913'
      )
      AND resolved_entity_id<>'01H00000000000000000000911'
  ) OR (SELECT count(*) FROM core.entity_resolution
         WHERE tenant_id='01H00000000000000000000901' AND entity_type='worker')<>3 THEN
    RAISE EXCEPTION 'A-B-C did not resolve as one transitive component';
  END IF;
  SELECT count(*),min(worker_id),sum(worked_minutes)::bigint
    INTO aggregate_rows,aggregate_worker,aggregate_minutes
    FROM (
      SELECT coalesce(resolution.resolved_entity_id,fact.worker_id) AS worker_id,
             sum(fact.worked_minutes)::bigint AS worked_minutes
      FROM mart.workforce_day_worker_location AS fact
      LEFT JOIN core.entity_resolution AS resolution
        ON resolution.tenant_id=fact.tenant_id
       AND resolution.entity_type='worker'
       AND resolution.member_entity_id=fact.worker_id
      WHERE fact.tenant_id='01H00000000000000000000901'
      GROUP BY coalesce(resolution.resolved_entity_id,fact.worker_id)
    ) AS governed;
  IF aggregate_rows<>1 OR aggregate_worker<>'01H00000000000000000000911'
     OR aggregate_minutes<>90 THEN
    RAISE EXCEPTION 'transitive governed aggregation is wrong: rows %, worker %, minutes %',
      aggregate_rows,aggregate_worker,aggregate_minutes;
  END IF;
END;
$$;

-- Undo only A-B. B-C must remain a component, and the post-merge B fact must
-- still be physically B while the governed aggregation follows the new graph.
DO $$
DECLARE
  candidates jsonb := jsonb_build_array(
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000911',
      'connection_id','01H00000000000000000000921',
      'source_object_type','Employee','source_record_id','employee-a','label','Worker A'
    ),
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000912',
      'connection_id','01H00000000000000000000922',
      'source_object_type','Employee','source_record_id','employee-b','label','Worker B'
    )
  );
  result jsonb;
  aggregate_rows integer;
  aggregate_worker text;
  aggregate_minutes bigint;
BEGIN
  result := semantic_internal.apply_identity_decision(
    '01H00000000000000000000901','01H00000000000000000000953',
    '01H00000000000000000000961',2,'proposed','worker',candidates,
    '00000000-0000-4000-8000-000000000001','2026-08-03T00:00:02Z'
  );
  IF result->>'applied' IS DISTINCT FROM 'true'
     OR (result->>'identityGraphVersion')::bigint IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'A-B undo returned unexpected metadata: %',result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM core.entity_resolution
     WHERE tenant_id='01H00000000000000000000901' AND entity_type='worker'
       AND member_entity_id='01H00000000000000000000911'
  ) OR (SELECT resolved_entity_id FROM core.entity_resolution
         WHERE tenant_id='01H00000000000000000000901' AND entity_type='worker'
           AND member_entity_id='01H00000000000000000000912')
       IS DISTINCT FROM '01H00000000000000000000912'
     OR (SELECT resolved_entity_id FROM core.entity_resolution
         WHERE tenant_id='01H00000000000000000000901' AND entity_type='worker'
           AND member_entity_id='01H00000000000000000000913')
       IS DISTINCT FROM '01H00000000000000000000912' THEN
    RAISE EXCEPTION 'A-B undo damaged the surviving B-C component';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.workforce_time_entry
     WHERE tenant_id='01H00000000000000000000901'
       AND id='01H00000000000000000000971'
       AND worker_id='01H00000000000000000000912'
  ) THEN
    RAISE EXCEPTION 'post-merge fact was rewritten away from native B';
  END IF;
  SELECT count(*),min(worker_id),sum(worked_minutes)::bigint
    INTO aggregate_rows,aggregate_worker,aggregate_minutes
    FROM (
      SELECT coalesce(resolution.resolved_entity_id,fact.worker_id) AS worker_id,
             sum(fact.worked_minutes)::bigint AS worked_minutes
      FROM mart.workforce_day_worker_location AS fact
      LEFT JOIN core.entity_resolution AS resolution
        ON resolution.tenant_id=fact.tenant_id
       AND resolution.entity_type='worker'
       AND resolution.member_entity_id=fact.worker_id
      WHERE fact.tenant_id='01H00000000000000000000901'
      GROUP BY coalesce(resolution.resolved_entity_id,fact.worker_id)
    ) AS governed;
  IF aggregate_rows<>1 OR aggregate_worker<>'01H00000000000000000000912'
     OR aggregate_minutes<>90 THEN
    RAISE EXCEPTION 'governed aggregation did not follow the undo: rows %, worker %, minutes %',
      aggregate_rows,aggregate_worker,aggregate_minutes;
  END IF;
END;
$$;

-- An older command is authoritative no-op state, not a fourth history event.
DO $$
DECLARE
  candidates jsonb := jsonb_build_array(
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000911',
      'connection_id','01H00000000000000000000921',
      'source_object_type','Employee','source_record_id','employee-a','label','Worker A'
    ),
    jsonb_build_object(
      'canonical_entity_id','01H00000000000000000000912',
      'connection_id','01H00000000000000000000922',
      'source_object_type','Employee','source_record_id','employee-b','label','Worker B'
    )
  );
  result jsonb;
BEGIN
  result := semantic_internal.apply_identity_decision(
    '01H00000000000000000000901','01H00000000000000000000954',
    '01H00000000000000000000961',1,'rejected','worker',candidates,
    '00000000-0000-4000-8000-000000000001','2026-08-03T00:00:03Z'
  );
  IF result->>'stale' IS DISTINCT FROM 'true'
     OR result->>'applied' IS DISTINCT FROM 'false'
     OR (result->>'identityGraphVersion')::bigint IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'older command was not a stale no-op: %',result;
  END IF;

  BEGIN
    PERFORM semantic_internal.apply_identity_decision(
      '01H00000000000000000000901','01H00000000000000000000951',
      '01H00000000000000000000961',1,'rejected','worker',candidates,
      '00000000-0000-4000-8000-000000000001','2026-08-03T00:00:00Z'
    );
    RAISE EXCEPTION 'changed replay unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22000' THEN
    NULL;
  END;
END;
$$;

-- Decisions never rewrite or supersede the native source anchors.
DO $$
DECLARE native_count integer;
BEGIN
  SELECT count(*) INTO native_count
    FROM core.entity_source_link AS link
   WHERE link.tenant_id='01H00000000000000000000901'
     AND link.entity_type='worker' AND link.valid_to IS NULL
     AND link.match_method='external_id' AND link.match_status='accepted'
     AND (link.source_record_id,link.canonical_entity_id) IN (
       ('employee-a','01H00000000000000000000911'),
       ('employee-b','01H00000000000000000000912'),
       ('employee-c','01H00000000000000000000913')
     );
  IF native_count<>3 OR EXISTS (
    SELECT 1 FROM core.entity_source_link
     WHERE tenant_id='01H00000000000000000000901'
       AND (match_method='user_confirmed' OR match_status='superseded')
  ) THEN
    RAISE EXCEPTION 'identity decisions mutated source-owned anchors';
  END IF;
END;
$$;

-- The new identity tables obey the same tenant RLS fence as canonical facts.
SELECT set_config('albert.tenant_id','01H00000000000000000000902',true);
DO $$
BEGIN
  IF (SELECT count(*) FROM core.entity_resolution)<>0 THEN
    RAISE EXCEPTION 'identity graph leaked through cross-tenant RLS';
  END IF;
END;
$$;
SELECT set_config('albert.tenant_id','01H00000000000000000000901',true);

RESET ROLE;
RESET SESSION AUTHORIZATION;

-- Administrative assertions prove stale/replay calls did not append history,
-- the first transition cleared cache, and immutable audit evidence rejects an
-- in-place rewrite even for the table owner path used by migrations.
DO $$
BEGIN
  IF (SELECT count(*) FROM semantic_internal.identity_decision_history
       WHERE tenant_id='01H00000000000000000000901')<>3 THEN
    RAISE EXCEPTION 'identity history contains a replay or stale duplicate';
  END IF;
  IF (SELECT count(*) FROM semantic_internal.identity_link_baseline
       WHERE tenant_id='01H00000000000000000000901')<>4 THEN
    RAISE EXCEPTION 'identity baselines were not captured once per task/source';
  END IF;
  IF EXISTS (
    SELECT 1 FROM semantic_internal.result_cache
     WHERE tenant_id='01H00000000000000000000901'
  ) THEN
    RAISE EXCEPTION 'identity graph transition did not clear semantic cache';
  END IF;
  IF (SELECT version FROM semantic_internal.identity_graph_state
       WHERE tenant_id='01H00000000000000000000901')<>3 THEN
    RAISE EXCEPTION 'replay or stale command advanced the graph version';
  END IF;

  BEGIN
    UPDATE semantic_internal.identity_decision_history
       SET decision='rejected'
     WHERE tenant_id='01H00000000000000000000901'
       AND decision_id='01H00000000000000000000951';
    RAISE EXCEPTION 'identity history was mutable';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
