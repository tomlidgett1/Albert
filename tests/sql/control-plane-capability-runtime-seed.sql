\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '38000000-0000-4000-8000-000000000038','authenticated','authenticated',
  'capability-runtime@example.com','',now(),'{}','{}',now(),now()
) ON CONFLICT(id) DO NOTHING;

INSERT INTO control_plane.internal_operators(user_id,email,reason)
VALUES(
  '38000000-0000-4000-8000-000000000038',
  'capability-runtime@example.com','CI exact-login capability boundary'
) ON CONFLICT(user_id) DO NOTHING;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status,created_by)
VALUES(
  '01H00000000000000000003801','capability-runtime-fixture',
  'Capability runtime fixture','active','38000000-0000-4000-8000-000000000038'
) ON CONFLICT(tenant_id) DO NOTHING;

INSERT INTO control_plane.pipeline_stats(
  tenant_id,snapshot_at,schema_name,table_name,row_count,invariant_status
) VALUES(
  '01H00000000000000000003801',now(),'source_xero','invoices',1,'{}'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub','38000000-0000-4000-8000-000000000038',true
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"38000000-0000-4000-8000-000000000038","role":"authenticated"}',
  true
);
SELECT public.begin_albert_operator_row_reveal(
  '01H00000000000000000003802','01H00000000000000000003801',
  'staging','source_xero','invoices',3
);

COMMIT;
