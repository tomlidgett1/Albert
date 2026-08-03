BEGIN;

-- Protected dogfood is the one release gate that must prove a real managed
-- Auth journey. Keep access to Auth's private audit ledger behind a fixed,
-- aggregate-only helper owned by the protected postgres administrator. Albert's
-- migration and runtime roles never receive table access or raw audit payloads.
DO $$
DECLARE required_column text;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'the protected dogfood Auth audit boundary requires the protected postgres login';
  END IF;
  IF to_regrole('albert_control_migration_owner') IS NULL THEN
    RAISE EXCEPTION 'albert_control_migration_owner is missing; run the base bootstrap first';
  END IF;
  IF to_regclass('auth.users') IS NULL
     OR to_regclass('auth.audit_log_entries') IS NULL THEN
    RAISE EXCEPTION 'managed Supabase Auth audit proof is unavailable';
  END IF;
  FOREACH required_column IN ARRAY ARRAY[
    'id','created_at','email_confirmed_at','raw_app_meta_data'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute attribute
       WHERE attribute.attrelid='auth.users'::regclass
         AND attribute.attname=required_column
         AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION 'managed Supabase Auth user proof column % is unavailable',required_column;
    END IF;
  END LOOP;
  FOREACH required_column IN ARRAY ARRAY['id','payload','created_at'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute attribute
       WHERE attribute.attrelid='auth.audit_log_entries'::regclass
         AND attribute.attname=required_column
         AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION 'managed Supabase Auth audit proof column % is unavailable',required_column;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_protected_dogfood_auth_audit_proof(
  p_user_id uuid,
  p_journey_issued_at timestamptz,
  p_claimed_at timestamptz,
  p_completed_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
SET statement_timeout='5s'
AS $$
DECLARE auth_user record;
DECLARE signup_event record;
DECLARE confirmation_event record;
DECLARE login_event record;
DECLARE email_provider boolean;
DECLARE signup_count integer;
DECLARE confirmation_count integer;
DECLARE login_count integer;
BEGIN
  IF p_user_id IS NULL
     OR p_journey_issued_at IS NULL
     OR p_claimed_at IS NULL
     OR p_completed_at IS NULL
     OR NOT (p_journey_issued_at<p_claimed_at AND p_claimed_at<p_completed_at)
     OR p_completed_at>statement_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'protected dogfood Auth proof input is invalid'
      USING ERRCODE='22023';
  END IF;
  IF to_regclass('auth.users') IS NULL
     OR to_regclass('auth.audit_log_entries') IS NULL THEN
    RAISE EXCEPTION 'managed Supabase Auth audit proof is unavailable'
      USING ERRCODE='55000';
  END IF;

  SELECT auth_user_row.id,auth_user_row.created_at,
         auth_user_row.email_confirmed_at,
         auth_user_row.raw_app_meta_data::jsonb AS app_metadata
    INTO auth_user
    FROM auth.users auth_user_row
   WHERE auth_user_row.id=p_user_id;
  email_provider:=coalesce(auth_user.app_metadata->>'provider','')='email'
    OR coalesce(auth_user.app_metadata->'providers','[]'::jsonb) ? 'email';
  IF auth_user.id IS NULL
     OR auth_user.created_at<p_journey_issued_at
     OR auth_user.created_at>p_claimed_at
     OR auth_user.email_confirmed_at IS NULL
     OR auth_user.email_confirmed_at<p_journey_issued_at
     OR auth_user.email_confirmed_at>p_claimed_at
     OR email_provider IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'fresh confirmed email Auth user proof is incomplete'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO signup_count
    FROM auth.audit_log_entries audit
   WHERE audit.created_at>=p_journey_issued_at
     AND audit.created_at<=p_claimed_at
     AND audit.payload::jsonb->>'actor_id'=p_user_id::text
     AND audit.payload::jsonb->>'action'='user_signedup';
  SELECT audit.id,audit.created_at,audit.payload::jsonb AS payload
    INTO signup_event
    FROM auth.audit_log_entries audit
   WHERE audit.created_at>=p_journey_issued_at
     AND audit.created_at<=p_claimed_at
     AND audit.payload::jsonb->>'actor_id'=p_user_id::text
     AND audit.payload::jsonb->>'action'='user_signedup'
   ORDER BY audit.created_at,audit.id
   LIMIT 1;
  SELECT count(*) INTO confirmation_count
    FROM auth.audit_log_entries audit
   WHERE audit.created_at>=p_journey_issued_at
     AND audit.created_at<=p_claimed_at
     AND audit.payload::jsonb->>'actor_id'=p_user_id::text
     AND audit.payload::jsonb->>'action'='user_confirmation_requested';
  SELECT audit.id,audit.created_at,audit.payload::jsonb AS payload
    INTO confirmation_event
    FROM auth.audit_log_entries audit
   WHERE audit.created_at>=p_journey_issued_at
     AND audit.created_at<=p_claimed_at
     AND audit.payload::jsonb->>'actor_id'=p_user_id::text
     AND audit.payload::jsonb->>'action'='user_confirmation_requested'
   ORDER BY audit.created_at,audit.id
   LIMIT 1;
  SELECT count(*) INTO login_count
    FROM auth.audit_log_entries audit
   WHERE audit.created_at>p_claimed_at
     AND audit.created_at<=p_completed_at
     AND audit.payload::jsonb->>'actor_id'=p_user_id::text
     AND audit.payload::jsonb->>'action'='login';
  SELECT audit.id,audit.created_at,audit.payload::jsonb AS payload
    INTO login_event
    FROM auth.audit_log_entries audit
   WHERE audit.created_at>p_claimed_at
     AND audit.created_at<=p_completed_at
     AND audit.payload::jsonb->>'actor_id'=p_user_id::text
     AND audit.payload::jsonb->>'action'='login'
   ORDER BY audit.created_at,audit.id
   LIMIT 1;
  IF signup_count<1 OR confirmation_count<1 OR login_count<1
     OR signup_event.id IS NULL OR confirmation_event.id IS NULL
     OR login_event.id IS NULL
     OR auth_user.created_at>confirmation_event.created_at
     OR confirmation_event.created_at>signup_event.created_at
     OR signup_event.created_at>auth_user.email_confirmed_at
     OR auth_user.email_confirmed_at>p_claimed_at
     OR login_event.created_at<=p_claimed_at
     OR login_event.created_at>p_completed_at THEN
    RAISE EXCEPTION 'managed Supabase signup, confirmation, or post-claim login audit proof is missing'
      USING ERRCODE='55000';
  END IF;

  RETURN jsonb_build_object(
    'proofVersion',1,
    'emailProvider',true,
    'subjectDigest',encode(extensions.digest(convert_to(p_user_id::text,'UTF8'),'sha256'),'hex'),
    'userCreatedAt',auth_user.created_at,
    'emailConfirmedAt',auth_user.email_confirmed_at,
    'signupAt',signup_event.created_at,
    'confirmationRequestedAt',confirmation_event.created_at,
    'postClaimLoginAt',login_event.created_at,
    'signupEventCount',signup_count,
    'confirmationRequestedEventCount',confirmation_count,
    'postClaimLoginEventCount',login_count,
    'signupEventDigest',encode(extensions.digest(convert_to(jsonb_build_object(
      'id',signup_event.id,'createdAt',signup_event.created_at,
      'payloadDigest',encode(extensions.digest(convert_to(signup_event.payload::text,'UTF8'),'sha256'),'hex')
    )::text,'UTF8'),'sha256'),'hex'),
    'confirmationEventDigest',encode(extensions.digest(convert_to(jsonb_build_object(
      'id',confirmation_event.id,'createdAt',confirmation_event.created_at,
      'payloadDigest',encode(extensions.digest(convert_to(confirmation_event.payload::text,'UTF8'),'sha256'),'hex')
    )::text,'UTF8'),'sha256'),'hex'),
    'loginEventDigest',encode(extensions.digest(convert_to(jsonb_build_object(
      'id',login_event.id,'createdAt',login_event.created_at,
      'payloadDigest',encode(extensions.digest(convert_to(login_event.payload::text,'UTF8'),'sha256'),'hex')
    )::text,'UTF8'),'sha256'),'hex')
  );
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_protected_dogfood_auth_audit_proof(
  uuid,timestamptz,timestamptz,timestamptz
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION extensions.albert_protected_dogfood_auth_audit_proof(
  uuid,timestamptz,timestamptz,timestamptz
) TO albert_control_migration_owner;

COMMIT;
