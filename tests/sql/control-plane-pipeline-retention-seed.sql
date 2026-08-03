\set ON_ERROR_STOP on

BEGIN;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status)
VALUES(
  '01H00000000000000000004801','pipeline-retention-fixture',
  'Pipeline retention fixture','active'
) ON CONFLICT(tenant_id) DO NOTHING;

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,status,auth_health,
  connection_generation
) VALUES(
  '01H00000000000000000004801','01H00000000000000000004802',
  'xero','Retention source','connected','healthy',1
) ON CONFLICT(tenant_id,connection_id) DO NOTHING;

INSERT INTO control_plane.pipeline_stats(
  tenant_id,snapshot_at,schema_name,table_name,row_count,invariant_status
) VALUES
  (
    '01H00000000000000000004801',
    date_trunc('hour',statement_timestamp())-interval '2 hours'+interval '10 minutes',
    'source_xero','invoices',1,'{}'
  ),
  (
    '01H00000000000000000004801',
    date_trunc('hour',statement_timestamp())-interval '2 hours'+interval '20 minutes',
    'source_xero','invoices',2,'{}'
  ),
  (
    '01H00000000000000000004801',
    statement_timestamp()-interval '401 days',
    'source_xero','invoices',3,'{}'
  );

COMMIT;
