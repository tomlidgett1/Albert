\set ON_ERROR_STOP on

BEGIN;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status) VALUES
  ('01J00000000000000000000201','authority-two-xero','Authority two Xero','active'),
  ('01J00000000000000000000202','authority-other','Authority other','active');

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,connection_generation
) VALUES
  ('01J00000000000000000000201','01J00000000000000000000211','xero','Xero AU','xero-au','connected','healthy',2),
  ('01J00000000000000000000201','01J00000000000000000000212','xero','Xero NZ','xero-nz','degraded','expiring',1),
  ('01J00000000000000000000201','01J00000000000000000000213','xero','Old Xero','xero-old','disconnected','revoked',1),
  ('01J00000000000000000000202','01J00000000000000000000214','xero','Other tenant Xero','xero-other','connected','healthy',1);

INSERT INTO control_plane.progressive_stream_coverage(
  tenant_id,connection_id,connection_generation,stream,dependencies,
  product_domains,covered_from,covered_to,status
) VALUES
  ('01J00000000000000000000201','01J00000000000000000000211',1,'journals','{}',ARRAY['accounting'],
   '2026-01-01T00:00:00Z','2026-02-01T00:00:00Z','pending'),
  ('01J00000000000000000000201','01J00000000000000000000211',2,'journals','{}',ARRAY['accounting'],
   '2026-07-01T00:00:00Z','2026-08-01T00:00:00Z','pending');

SET LOCAL ROLE albert_semantic_control;
SELECT set_config('albert.tenant_id','01J00000000000000000000201',true);

DO $$
DECLARE inventory_count integer;
DECLARE current_coverage_count integer;
DECLARE current_covered_from timestamptz;
BEGIN
  SELECT count(*) INTO inventory_count
    FROM control_plane.semantic_connection_scopes();
  IF inventory_count<>2
     OR (SELECT count(*) FROM control_plane.semantic_connection_scopes()
          WHERE connector_id='xero' AND authority_eligible)<>2
     OR EXISTS (
       SELECT 1 FROM control_plane.semantic_connection_scopes()
        WHERE connection_id IN (
          '01J00000000000000000000213','01J00000000000000000000214'
        )
     ) THEN
    RAISE EXCEPTION 'semantic connection inventory leaked or collapsed accounts';
  END IF;

  SELECT count(*),min(covered_from)
    INTO current_coverage_count,current_covered_from
    FROM control_plane.semantic_progressive_stream_coverage()
   WHERE connection_id='01J00000000000000000000211' AND stream='journals';
  IF current_coverage_count<>1 OR current_covered_from<>'2026-07-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'semantic progressive coverage did not fence connection generation';
  END IF;

  BEGIN
    PERFORM 1 FROM control_plane.connections LIMIT 1;
    RAISE EXCEPTION 'semantic role read connection secrets/metadata table directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;
ROLLBACK;
