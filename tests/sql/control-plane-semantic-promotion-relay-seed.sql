\set ON_ERROR_STOP on

BEGIN;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status)
VALUES(
  '01H00000000000000000004301','semantic-promotion-relay-fixture',
  'Semantic promotion relay fixture','active'
) ON CONFLICT(tenant_id) DO NOTHING;

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,status,auth_health,
  connection_generation
) VALUES
  (
    '01H00000000000000000004301','01H00000000000000000004302',
    'xero','Relay source','connected','healthy',1
  ),
  (
    '01H00000000000000000004301','01H00000000000000000004309',
    'xero','Disconnected relay source','disconnected','revoked',1
  )
ON CONFLICT(tenant_id,connection_id) DO NOTHING;

COMMIT;
