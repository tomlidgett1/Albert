\set ON_ERROR_STOP on

-- Reproduces two same-named organisations observed from two browser tabs. A
-- stale tab must fail closed instead of applying its action to the tenant that
-- another tab selected later.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'explicit organisation target assertion failed: %', message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_sqlstate(
  statement text,
  expected_state text,
  message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_state THEN
      RETURN;
    END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'explicit organisation target unexpectedly succeeded: %', message;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
  (
    '6e000000-0000-4000-8000-000000000001','authenticated','authenticated',
    'explicit-target-owner@albert.invalid','',now(),'{}','{}',now(),now()
  ),
  (
    '6e000000-0000-4000-8000-000000000002','authenticated','authenticated',
    'explicit-target-member@albert.invalid','',now(),'{}','{}',now(),now()
  );

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub','6e000000-0000-4000-8000-000000000001',true
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"6e000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Shared Trading Co','Australia/Melbourne'
) \gset explicit_target_a_
SELECT * FROM public.albert_create_organisation(
  'Shared Trading Co','Australia/Melbourne'
) \gset explicit_target_b_

SELECT pg_temp.assert_true(
  (SELECT count(*) = 2
     FROM control_plane.tenants
    WHERE tenant_id IN (
      :'explicit_target_a_tenant_id',:'explicit_target_b_tenant_id'
    ) AND display_name = 'Shared Trading Co'),
  'the fixture must contain two same-named organisations'
);
SELECT pg_temp.assert_true(
  (SELECT tenant_id = :'explicit_target_b_tenant_id'
     FROM public.current_albert_context()),
  'the second tab must have selected organisation B'
);

SELECT pg_temp.expect_sqlstate(
  format(
    'SELECT public.albert_rename_organisation(%L,%L)',
    :'explicit_target_a_tenant_id','Wrong Tenant Rename'
  ),
  '55000',
  'a stale rename for A must not rename selected organisation B'
);
SELECT pg_temp.expect_sqlstate(
  format(
    'SELECT public.albert_add_organisation_member(%L,%L,%L)',
    :'explicit_target_a_tenant_id','explicit-target-member@albert.invalid','manager'
  ),
  '55000',
  'a stale member grant for A must not grant access to selected organisation B'
);
SELECT pg_temp.expect_sqlstate(
  format(
    'SELECT * FROM public.albert_request_tenant_deletion(%L,%L)',
    :'explicit_target_a_tenant_id','DELETE Shared Trading Co'
  ),
  '55000',
  'a stale deletion request for A must not target selected organisation B'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2
     FROM control_plane.tenants
    WHERE tenant_id IN (
      :'explicit_target_a_tenant_id',:'explicit_target_b_tenant_id'
    ) AND display_name = 'Shared Trading Co'),
  'stale rename must not mutate either organisation'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.memberships
     WHERE user_id = '6e000000-0000-4000-8000-000000000002'
  ),
  'stale member grant must not create access in either organisation'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.deletion_requests
     WHERE tenant_id IN (
       :'explicit_target_a_tenant_id',:'explicit_target_b_tenant_id'
     ) AND scope = 'tenant'
  ),
  'stale deletion request must not create a job for either organisation'
);

-- The exact current target remains operable.
SELECT public.albert_rename_organisation(
  :'explicit_target_b_tenant_id','Selected Trading Co'
);
SELECT public.albert_add_organisation_member(
  :'explicit_target_b_tenant_id',
  'explicit-target-member@albert.invalid','manager'
);
SELECT public.albert_select_organisation(:'explicit_target_a_tenant_id');
SELECT pg_temp.expect_sqlstate(
  format(
    'SELECT public.albert_update_organisation_member(%L,%L,%L,%L)',
    :'explicit_target_b_tenant_id',
    '6e000000-0000-4000-8000-000000000002','owner','active'
  ),
  '55000',
  'a stale member role change for B must not mutate selected organisation A'
);
SELECT pg_temp.assert_true(
  (SELECT role = 'manager' AND status = 'active'
     FROM control_plane.memberships
    WHERE tenant_id = :'explicit_target_b_tenant_id'
      AND user_id = '6e000000-0000-4000-8000-000000000002'),
  'stale member update must leave the intended B membership unchanged'
);

SELECT public.albert_select_organisation(:'explicit_target_b_tenant_id');
SELECT * FROM public.albert_request_tenant_deletion(
  :'explicit_target_b_tenant_id','DELETE Selected Trading Co'
) \gset explicit_target_deletion_
SELECT public.albert_select_organisation(:'explicit_target_a_tenant_id');
SELECT pg_temp.expect_sqlstate(
  format(
    'SELECT * FROM public.albert_approve_tenant_deletion(%L,%L,%L)',
    :'explicit_target_b_tenant_id',
    :'explicit_target_deletion_deletion_request_id',
    'ERASE Selected Trading Co'
  ),
  '55000',
  'a stale final approval must not erase whichever organisation is selected now'
);
SELECT pg_temp.expect_sqlstate(
  format(
    'SELECT public.albert_cancel_tenant_deletion(%L,%L)',
    :'explicit_target_b_tenant_id',
    :'explicit_target_deletion_deletion_request_id'
  ),
  '55000',
  'a stale cancellation must not act through a different selected organisation'
);
SELECT pg_temp.assert_true(
  (SELECT status = 'awaiting_approval'
     FROM control_plane.deletion_requests
    WHERE tenant_id = :'explicit_target_b_tenant_id'
      AND deletion_request_id = :'explicit_target_deletion_deletion_request_id'),
  'stale approval and cancellation must leave the B request unchanged'
);
SELECT public.albert_select_organisation(:'explicit_target_b_tenant_id');
SELECT public.albert_cancel_tenant_deletion(
  :'explicit_target_b_tenant_id',
  :'explicit_target_deletion_deletion_request_id'
);
SELECT pg_temp.assert_true(
  (SELECT status = 'cancelled'
     FROM control_plane.deletion_requests
    WHERE tenant_id = :'explicit_target_b_tenant_id'
      AND deletion_request_id = :'explicit_target_deletion_deletion_request_id'),
  'an exact current target must permit cancellation'
);

RESET ROLE;
SELECT pg_temp.assert_true(
  to_regprocedure('public.albert_rename_organisation(text)') IS NULL
  AND to_regprocedure('public.albert_add_organisation_member(text,text)') IS NULL
  AND to_regprocedure('public.albert_update_organisation_member(uuid,text,text)') IS NULL
  AND to_regprocedure('public.albert_request_tenant_deletion(text)') IS NULL
  AND to_regprocedure('public.albert_approve_tenant_deletion(text,text)') IS NULL
  AND to_regprocedure('public.albert_cancel_tenant_deletion(text)') IS NULL,
  'every context-only mutation overload must be removed'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'authenticated','public.albert_rename_organisation(text,text)','EXECUTE'
  )
  AND has_function_privilege(
    'authenticated','public.albert_add_organisation_member(text,text,text)','EXECUTE'
  )
  AND has_function_privilege(
    'authenticated','public.albert_update_organisation_member(text,uuid,text,text)','EXECUTE'
  )
  AND has_function_privilege(
    'authenticated','public.albert_request_tenant_deletion(text,text)','EXECUTE'
  )
  AND has_function_privilege(
    'authenticated','public.albert_approve_tenant_deletion(text,text,text)','EXECUTE'
  )
  AND has_function_privilege(
    'authenticated','public.albert_cancel_tenant_deletion(text,text)','EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'control_plane.require_expected_active_tenant(text,text[])','EXECUTE'
  ),
  'authenticated mutations must use only the explicit public target boundary'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'anon','public.albert_request_tenant_deletion(text,text)','EXECUTE'
  ),
  'anonymous callers must not execute explicit organisation mutations'
);

ROLLBACK;
