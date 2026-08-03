BEGIN;

-- Managed Supabase grants the protected postgres login enough access to use
-- Auth, but deliberately withholds grant options for the auth schema and the
-- REFERENCES privilege on auth.users. Keep Albert's migration owner isolated:
-- fixed helpers expose only caller claims, exact user-directory fields, and a
-- no-argument set of reviewed foreign keys.
DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'the Supabase Auth compatibility boundary requires the protected postgres login';
  END IF;
  IF to_regrole('albert_control_migration_owner') IS NULL THEN
    RAISE EXCEPTION 'albert_control_migration_owner is missing; run the base bootstrap first';
  END IF;
  IF to_regclass('auth.users') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'the required managed Supabase Auth objects are missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_auth_uid()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT auth.uid()
$$;

CREATE OR REPLACE FUNCTION extensions.albert_auth_jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT auth.jwt()
$$;

REVOKE ALL ON FUNCTION extensions.albert_auth_uid()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION extensions.albert_auth_jwt()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION extensions.albert_auth_uid()
  TO anon, authenticated, albert_control_migration_owner;
GRANT EXECUTE ON FUNCTION extensions.albert_auth_jwt()
  TO anon, authenticated, albert_control_migration_owner;

CREATE OR REPLACE FUNCTION extensions.albert_auth_users_by_ids(p_user_ids uuid[])
RETURNS TABLE(id uuid, email text, email_confirmed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $$
BEGIN
  IF p_user_ids IS NULL
     OR cardinality(p_user_ids) NOT BETWEEN 1 AND 256
     OR array_position(p_user_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'one to 256 non-null Auth user IDs are required'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT auth_user.id, auth_user.email::text, auth_user.email_confirmed_at
    FROM auth.users AS auth_user
   WHERE auth_user.id = ANY(p_user_ids)
   ORDER BY auth_user.id;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_auth_confirmed_user_by_email(
  p_normalized_email text
)
RETURNS TABLE(id uuid, email text, email_confirmed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $$
BEGIN
  IF p_normalized_email IS NULL
     OR p_normalized_email <> lower(btrim(p_normalized_email))
     OR length(p_normalized_email) NOT BETWEEN 3 AND 320
     OR p_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'a normalized email address is required'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT auth_user.id, auth_user.email::text, auth_user.email_confirmed_at
    FROM auth.users AS auth_user
   WHERE lower(auth_user.email) = p_normalized_email
     AND auth_user.email_confirmed_at IS NOT NULL
   ORDER BY auth_user.id
   LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_auth_users_by_ids(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION extensions.albert_auth_confirmed_user_by_email(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION extensions.albert_auth_users_by_ids(uuid[])
  TO albert_control_migration_owner;
GRANT EXECUTE ON FUNCTION extensions.albert_auth_confirmed_user_by_email(text)
  TO albert_control_migration_owner;

CREATE OR REPLACE FUNCTION extensions.albert_install_auth_user_foreign_keys()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '10s'
AS $$
DECLARE
  expected record;
  selected_table regclass;
  selected_column smallint;
  auth_user_id_column smallint;
  existing pg_constraint%ROWTYPE;
  delete_sql text;
BEGIN
  SELECT attribute.attnum
    INTO STRICT auth_user_id_column
    FROM pg_attribute AS attribute
   WHERE attribute.attrelid = 'auth.users'::regclass
     AND attribute.attname = 'id'
     AND NOT attribute.attisdropped;

  FOR expected IN
    SELECT * FROM (VALUES
      ('control_plane','audit_log','actor_user_id','audit_log_actor_user_id_fkey','n'),
      ('control_plane','clarification_prompts','offered_by','clarification_prompts_offered_by_fkey','r'),
      ('control_plane','connections','authorised_by','connections_authorised_by_fkey','n'),
      ('control_plane','conversation_turns','created_by','conversation_turns_created_by_fkey','r'),
      ('control_plane','conversations','created_by','conversations_created_by_fkey','r'),
      ('control_plane','deletion_requests','approved_by','deletion_requests_approved_by_fkey','n'),
      ('control_plane','deletion_requests','requested_by','deletion_requests_requested_by_fkey','n'),
      ('control_plane','dossiers','created_by','dossiers_created_by_fkey','n'),
      ('control_plane','identity_decision_projection_outbox','decided_by','identity_decision_projection_outbox_decided_by_fkey','r'),
      ('control_plane','identity_review_decisions','decided_by','identity_review_decisions_decided_by_fkey','r'),
      ('control_plane','identity_review_tasks','assigned_to','identity_review_tasks_assigned_to_fkey','n'),
      ('control_plane','identity_review_tasks','resolved_by','identity_review_tasks_resolved_by_fkey','n'),
      ('control_plane','internal_operators','granted_by','internal_operators_granted_by_fkey','n'),
      ('control_plane','internal_operators','user_id','internal_operators_user_id_fkey','c'),
      ('control_plane','memberships','created_by','memberships_created_by_fkey','n'),
      ('control_plane','memberships','user_id','memberships_user_id_fkey','c'),
      ('control_plane','model_usage_ledger','recorded_by','model_usage_ledger_recorded_by_fkey','r'),
      ('control_plane','model_usage_outcomes','recorded_by','model_usage_outcomes_recorded_by_fkey','r'),
      ('control_plane','oauth_sessions','initiated_by','oauth_sessions_initiated_by_fkey','c'),
      ('control_plane','onboarding_question_responses','answered_by','onboarding_question_responses_answered_by_fkey','r'),
      ('control_plane','operator_audit_log','actor_user_id','operator_audit_log_actor_user_id_fkey','r'),
      ('control_plane','operator_diagnostic_reveal_requests','actor_user_id','operator_diagnostic_reveal_requests_actor_user_id_fkey','r'),
      ('control_plane','semantic_inbox','reviewed_by','semantic_inbox_reviewed_by_fkey','n'),
      ('control_plane','semantic_publications','created_by','semantic_publications_created_by_fkey','n'),
      ('control_plane','sync_runs','requested_by','sync_runs_requested_by_fkey','n'),
      ('control_plane','tenant_overlays','created_by','tenant_overlays_created_by_fkey','n'),
      ('control_plane','tenants','created_by','tenants_created_by_fkey','n'),
      ('control_plane','user_active_tenants','user_id','user_active_tenants_user_id_fkey','c')
    ) AS specification(schema_name, table_name, column_name, constraint_name, delete_action)
  LOOP
    selected_table := to_regclass(format('%I.%I', expected.schema_name, expected.table_name));
    IF selected_table IS NULL THEN
      RAISE EXCEPTION 'required Auth reference table %.% is missing',
        expected.schema_name, expected.table_name;
    END IF;
    IF pg_get_userbyid((SELECT class.relowner FROM pg_class AS class WHERE class.oid=selected_table))
       <> 'albert_control_migration_owner' THEN
      RAISE EXCEPTION 'Auth reference table %.% is not owned by the migration owner',
        expected.schema_name, expected.table_name;
    END IF;
    SELECT attribute.attnum
      INTO selected_column
      FROM pg_attribute AS attribute
     WHERE attribute.attrelid = selected_table
       AND attribute.attname = expected.column_name
       AND attribute.atttypid = 'uuid'::regtype
       AND NOT attribute.attisdropped;
    IF selected_column IS NULL THEN
      RAISE EXCEPTION 'required uuid column %.%.% is missing',
        expected.schema_name, expected.table_name, expected.column_name;
    END IF;

    SELECT constraint_row.*
      INTO existing
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = selected_table
       AND constraint_row.conname = expected.constraint_name;
    IF FOUND THEN
      IF existing.contype <> 'f'
         OR existing.confrelid <> 'auth.users'::regclass
         OR existing.conkey <> ARRAY[selected_column]::smallint[]
         OR existing.confkey <> ARRAY[auth_user_id_column]::smallint[]
         OR existing.confdeltype <> expected.delete_action::"char"
         OR existing.confupdtype <> 'a'
         OR existing.confmatchtype <> 's'
         OR existing.condeferrable
         OR existing.condeferred
         OR NOT existing.convalidated THEN
        RAISE EXCEPTION 'Auth reference constraint % has an unexpected definition',
          expected.constraint_name;
      END IF;
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_constraint AS other
       WHERE other.conrelid = selected_table
         AND other.contype = 'f'
         AND other.conkey = ARRAY[selected_column]::smallint[]
    ) THEN
      RAISE EXCEPTION 'column %.%.% has an unexpected foreign key',
        expected.schema_name, expected.table_name, expected.column_name;
    END IF;

    delete_sql := CASE expected.delete_action
      WHEN 'n' THEN 'SET NULL'
      WHEN 'c' THEN 'CASCADE'
      WHEN 'r' THEN 'RESTRICT'
      ELSE NULL
    END;
    IF delete_sql IS NULL THEN
      RAISE EXCEPTION 'invalid fixed Auth delete action';
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES auth.users(id) ON UPDATE NO ACTION ON DELETE %s NOT DEFERRABLE',
      expected.schema_name,
      expected.table_name,
      expected.constraint_name,
      expected.column_name,
      delete_sql
    );
  END LOOP;

  -- The one-time base bootstrap could grant only these three columns because
  -- postgres holds SELECT WITH GRANT OPTION. Remove that temporary bridge once
  -- every final function uses the fixed directory helpers above.
  REVOKE SELECT (id, email, email_confirmed_at) ON auth.users
    FROM albert_control_migration_owner;
  IF has_any_column_privilege(
    'albert_control_migration_owner',
    'auth.users',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'the migration owner retains direct Auth user reads';
  END IF;

  -- This reviewed installer is consumed atomically by migration 0042. It has
  -- no parameters, but it is still removed after its one required execution.
  REVOKE EXECUTE ON FUNCTION extensions.albert_install_auth_user_foreign_keys()
    FROM albert_control_migration_owner;
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_install_auth_user_foreign_keys()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION extensions.albert_install_auth_user_foreign_keys()
  TO albert_control_migration_owner;

COMMIT;
