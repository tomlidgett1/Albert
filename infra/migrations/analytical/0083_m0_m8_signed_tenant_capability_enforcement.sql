BEGIN;

CREATE SCHEMA capability_internal;
REVOKE ALL ON SCHEMA capability_internal
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;

CREATE TABLE capability_internal.verification_keys (
  key_id text PRIMARY KEY CHECK(key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  secret bytea NOT NULL CHECK(octet_length(secret) BETWEEN 32 AND 64),
  fingerprint text NOT NULL UNIQUE CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  active_at timestamptz NOT NULL,
  retire_at timestamptz NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(retire_at>active_at+interval '5 minutes')
);

-- A consumed deletion nonce deliberately contains no tenant or connection
-- identifier, so final tenant erasure can retain replay protection without
-- retaining customer data.
CREATE TABLE capability_internal.consumed_deletion_nonces (
  nonce text PRIMARY KEY CHECK(nonce ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  token_digest text NOT NULL UNIQUE CHECK(token_digest ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK(operation IN ('deletion_purge','deletion_verify')),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK(expires_at>consumed_at-interval '5 minutes')
);

-- A purge leaves only a one-way digest of the random tenant ULID and the last
-- second in which an already-issued token is unsafe. This is not a customer
-- identifier and cannot be used to enumerate a tenant, but it prevents a
-- pre-purge capability from recreating data after the exclusive purge
-- transaction commits. Connection purges intentionally revoke the whole
-- tenant's outstanding token set because semantic tokens are tenant-wide.
CREATE TABLE capability_internal.tenant_revocation_watermarks (
  tenant_digest text PRIMARY KEY CHECK(tenant_digest ~ '^[a-f0-9]{64}$'),
  revoked_through_epoch bigint NOT NULL CHECK(revoked_through_epoch>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON ALL TABLES IN SCHEMA capability_internal
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;

CREATE OR REPLACE FUNCTION capability_internal.install_verification_key(
  p_key_id text,p_secret_base64 text,p_active_at timestamptz,p_retire_at timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
DECLARE decoded bytea;digest text;
BEGIN
  IF current_user<>'albert_migration_owner' THEN
    RAISE EXCEPTION 'capability keys can only be installed by the migration owner'
      USING ERRCODE='42501';
  END IF;
  IF p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
     OR p_secret_base64 IS NULL OR length(p_secret_base64) NOT BETWEEN 44 AND 88
     OR p_active_at IS NULL OR p_retire_at IS NULL
     OR p_retire_at<=p_active_at+interval '5 minutes' THEN
    RAISE EXCEPTION 'analytical verification key metadata is invalid' USING ERRCODE='22023';
  END IF;
  BEGIN
    decoded:=decode(p_secret_base64,'base64');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'analytical verification key encoding is invalid' USING ERRCODE='22023';
  END;
  IF octet_length(decoded) NOT BETWEEN 32 AND 64 THEN
    RAISE EXCEPTION 'analytical verification key must contain 32 to 64 bytes'
      USING ERRCODE='22023';
  END IF;
  digest:=encode(extensions.digest(decoded,'sha256'),'hex');
  IF EXISTS(
    SELECT 1 FROM capability_internal.verification_keys key
    WHERE key.key_id=p_key_id AND key.secret<>decoded
  ) THEN
    RAISE EXCEPTION 'analytical capability key identifiers are immutable'
      USING ERRCODE='22023';
  END IF;
  INSERT INTO capability_internal.verification_keys(
    key_id,secret,fingerprint,active_at,retire_at
  ) VALUES(p_key_id,decoded,digest,p_active_at,p_retire_at)
  ON CONFLICT(key_id) DO UPDATE SET
    secret=excluded.secret,fingerprint=excluded.fingerprint,
    active_at=excluded.active_at,retire_at=excluded.retire_at,
    installed_at=clock_timestamp();
  RETURN digest;
END;
$$;

CREATE OR REPLACE FUNCTION capability_internal.retire_verification_key(
  p_key_id text,p_retire_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
BEGIN
  IF current_user<>'albert_migration_owner' THEN
    RAISE EXCEPTION 'capability keys can only be retired by the migration owner'
      USING ERRCODE='42501';
  END IF;
  IF p_retire_at<=clock_timestamp()+interval '10 minutes' THEN
    RAISE EXCEPTION 'capability key retirement requires a ten-minute drain window'
      USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM capability_internal.verification_keys replacement
     WHERE replacement.key_id<>p_key_id
       AND replacement.active_at<=p_retire_at-interval '5 minutes'
       AND replacement.retire_at>p_retire_at+interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'capability key retirement has no overlapping replacement'
      USING ERRCODE='55000';
  END IF;
  UPDATE capability_internal.verification_keys key
     SET retire_at=p_retire_at
   WHERE key.key_id=p_key_id AND p_retire_at>key.active_at+interval '5 minutes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability key retirement target is invalid' USING ERRCODE='22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION capability_internal.prune_retired_verification_keys()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
DECLARE removed integer;
BEGIN
  IF current_user<>'albert_migration_owner' THEN
    RAISE EXCEPTION 'capability keys can only be pruned by the migration owner'
      USING ERRCODE='42501';
  END IF;
  DELETE FROM capability_internal.verification_keys key
   WHERE key.retire_at<clock_timestamp()-interval '10 minutes';
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION capability_internal.install_verification_key(text,text,timestamptz,timestamptz)
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
REVOKE ALL ON FUNCTION capability_internal.retire_verification_key(text,timestamptz),
  capability_internal.prune_retired_verification_keys()
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT USAGE ON SCHEMA capability_internal TO albert_migration_owner;
GRANT EXECUTE ON FUNCTION
  capability_internal.install_verification_key(text,text,timestamptz,timestamptz),
  capability_internal.retire_verification_key(text,timestamptz),
  capability_internal.prune_retired_verification_keys()
  TO albert_migration_owner;

CREATE OR REPLACE FUNCTION capability_internal.secure_equals(p_left bytea,p_right bytea)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
DECLARE difference integer:=octet_length(p_left)#octet_length(p_right);position integer;
BEGIN
  FOR position IN 0..greatest(octet_length(p_left),octet_length(p_right))-1 LOOP
    difference:=difference | (
      get_byte(p_left,least(position,greatest(octet_length(p_left)-1,0))) #
      get_byte(p_right,least(position,greatest(octet_length(p_right)-1,0)))
    );
  END LOOP;
  RETURN difference=0;
END;
$$;

CREATE OR REPLACE FUNCTION capability_internal.expected_runtime_binding()
RETURNS TABLE(audience text,allowed_scopes text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE expected_group text;login_oid oid;unsafe boolean;
BEGIN
  CASE session_user
    WHEN 'albert_ingest_runtime' THEN
      audience:='analytical:ingest';allowed_scopes:=ARRAY['ingest'];expected_group:='ingest_rw';
    WHEN 'albert_transform_analytical_runtime' THEN
      audience:='analytical:transform';allowed_scopes:=ARRAY['transform'];expected_group:='transform_rw';
    WHEN 'albert_semantic_read_runtime' THEN
      audience:='analytical:semantic-read';allowed_scopes:=ARRAY['semantic_read'];expected_group:='semantic_ro';
    WHEN 'albert_semantic_metadata_runtime' THEN
      audience:='analytical:semantic-metadata';allowed_scopes:=ARRAY['semantic_metadata'];expected_group:='semantic_meta_rw';
    WHEN 'albert_operator_diagnostic_analytical_runtime' THEN
      audience:='analytical:diagnostic';allowed_scopes:=ARRAY['diagnostic'];expected_group:='diagnostic_ro';
    WHEN 'albert_deletion_analytical_runtime' THEN
      audience:='analytical:deletion';allowed_scopes:=ARRAY['deletion_purge','deletion_verify'];expected_group:='deletion_rw';
    ELSE
      RAISE EXCEPTION 'analytical capability session identity is not authorized'
        USING ERRCODE='42501';
  END CASE;
  SELECT role.oid,
         role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
           OR role.rolreplication OR role.rolbypassrls OR role.rolinherit
    INTO login_oid,unsafe FROM pg_catalog.pg_roles role WHERE role.rolname=session_user;
  IF login_oid IS NULL OR unsafe
     OR NOT pg_catalog.pg_has_role(session_user,expected_group,'member')
     OR EXISTS(
       SELECT 1 FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
       WHERE membership.member=login_oid AND granted.rolname<>expected_group
     ) THEN
    RAISE EXCEPTION 'analytical capability session has an unsafe role boundary'
      USING ERRCODE='42501';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION capability_internal.verify_token(
  p_token text,p_required_scope text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  envelope jsonb;payload jsonb;signature text;key_row capability_internal.verification_keys%ROWTYPE;
  expected_signature bytea;presented_signature bytea;binding record;
  issued_epoch bigint;expires_epoch bigint;now_epoch bigint;
BEGIN
  IF p_token IS NULL OR length(p_token) NOT BETWEEN 100 AND 4096 THEN
    RAISE EXCEPTION 'analytical capability is missing or malformed' USING ERRCODE='42501';
  END IF;
  BEGIN
    envelope:=p_token::jsonb;payload:=envelope->'payload';signature:=envelope->>'signature';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'analytical capability is missing or malformed' USING ERRCODE='42501';
  END;
  IF jsonb_typeof(envelope)<>'object'
     OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(envelope))<>2
     OR jsonb_typeof(payload)<>'object'
     OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(payload))<>10
     OR NOT (payload ?& ARRAY[
       'version','key_id','tenant_id','audience','scope','subject','nonce',
       'issued_at','expires_at','evidence'
     ])
     OR payload->>'version'<>'1'
     OR NOT core.is_ulid(payload->>'tenant_id')
     OR (payload->>'nonce') !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
     OR length(payload->>'subject') NOT BETWEEN 3 AND 320
     OR jsonb_typeof(payload->'evidence')<>'object'
     OR signature !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'analytical capability is missing or malformed' USING ERRCODE='42501';
  END IF;
  BEGIN
    issued_epoch:=(payload->>'issued_at')::bigint;
    expires_epoch:=(payload->>'expires_at')::bigint;
    presented_signature:=decode(signature,'hex');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'analytical capability is missing or malformed' USING ERRCODE='42501';
  END;
  now_epoch:=floor(extract(epoch FROM clock_timestamp()))::bigint;
  IF issued_epoch>now_epoch+5 OR expires_epoch<=now_epoch
     OR expires_epoch<=issued_epoch OR expires_epoch-issued_epoch>301 THEN
    RAISE EXCEPTION 'analytical capability is expired or not yet valid' USING ERRCODE='42501';
  END IF;
  SELECT * INTO key_row FROM capability_internal.verification_keys key
   WHERE key.key_id=payload->>'key_id'
     AND key.active_at<=to_timestamp(issued_epoch)
     AND key.retire_at>=to_timestamp(expires_epoch);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'analytical capability signing key is unavailable' USING ERRCODE='42501';
  END IF;
  expected_signature:=extensions.hmac(convert_to(payload::text,'utf8'),key_row.secret,'sha256');
  IF NOT capability_internal.secure_equals(expected_signature,presented_signature) THEN
    RAISE EXCEPTION 'analytical capability signature is invalid' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT binding FROM capability_internal.expected_runtime_binding();
  IF payload->>'audience' IS DISTINCT FROM binding.audience
     OR NOT ((payload->>'scope')=ANY(binding.allowed_scopes))
     OR (p_required_scope IS NOT NULL AND payload->>'scope' IS DISTINCT FROM p_required_scope) THEN
    RAISE EXCEPTION 'analytical capability audience or scope is invalid' USING ERRCODE='42501';
  END IF;
  IF payload->>'scope' NOT IN ('deletion_purge','deletion_verify')
     AND EXISTS(
       SELECT 1 FROM capability_internal.tenant_revocation_watermarks watermark
        WHERE watermark.tenant_digest=encode(
          extensions.digest(convert_to(payload->>'tenant_id','utf8'),'sha256'),'hex'
        )
          AND issued_epoch<=watermark.revoked_through_epoch
     ) THEN
    RAISE EXCEPTION 'analytical capability predates tenant data revocation'
      USING ERRCODE='42501';
  END IF;
  RETURN payload;
END;
$$;

CREATE OR REPLACE FUNCTION capability_internal.assert_verifier_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM capability_internal.verification_keys key
    WHERE key.active_at<=statement_timestamp()
      AND key.retire_at>statement_timestamp()+interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'no active analytical capability verification key is installed'
      USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

-- Migration/admin sessions keep an explicit bootstrap path for fixture and
-- migration SQL.  Every fixed production runtime login is forced through the
-- signed-token verifier; setting albert.tenant_id alone has no effect.
CREATE OR REPLACE FUNCTION core.current_tenant_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;selected text;
BEGIN
  IF pg_catalog.pg_has_role(session_user,'albert_migration_owner','member') THEN
    selected:=nullif(current_setting('albert.tenant_id',true),'');
    IF selected IS NULL OR NOT core.is_ulid(selected) THEN
      RAISE EXCEPTION 'migration tenant context is missing or invalid' USING ERRCODE='42501';
    END IF;
    RETURN selected;
  END IF;
  claims:=capability_internal.verify_token(
    nullif(current_setting('albert.tenant_capability',true),''),NULL
  );
  RETURN claims->>'tenant_id';
END;
$$;

CREATE OR REPLACE FUNCTION ingestion.current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$ SELECT core.current_tenant_id() $$;

CREATE OR REPLACE FUNCTION capability_internal.activate_deletion_capability(
  p_required_scope text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE token text;claims jsonb;nonce text;expires_at timestamptz;
BEGIN
  IF p_required_scope NOT IN ('deletion_purge','deletion_verify') THEN
    RAISE EXCEPTION 'deletion capability scope is invalid' USING ERRCODE='22023';
  END IF;
  token:=nullif(current_setting('albert.tenant_capability',true),'');
  claims:=capability_internal.verify_token(token,p_required_scope);
  nonce:=claims->>'nonce';expires_at:=to_timestamp((claims->>'expires_at')::bigint);
  DELETE FROM capability_internal.consumed_deletion_nonces consumed
   WHERE consumed.expires_at<clock_timestamp()-interval '5 minutes';
  INSERT INTO capability_internal.consumed_deletion_nonces(
    nonce,token_digest,operation,expires_at
  ) VALUES(
    nonce,encode(extensions.digest(convert_to(token,'utf8'),'sha256'),'hex'),
    p_required_scope,expires_at
  );
  PERFORM set_config('albert.activated_deletion_nonce',nonce,true);
  RETURN claims;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'deletion analytical capability was already consumed'
    USING ERRCODE='42501';
END;
$$;

CREATE OR REPLACE FUNCTION capability_internal.record_tenant_revocation(p_tenant_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE tenant_digest_value text;revoked_epoch bigint;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant revocation target is invalid' USING ERRCODE='22023';
  END IF;
  tenant_digest_value:=encode(
    extensions.digest(convert_to(p_tenant_id,'utf8'),'sha256'),'hex'
  );
  revoked_epoch:=floor(extract(epoch FROM clock_timestamp()))::bigint;
  INSERT INTO capability_internal.tenant_revocation_watermarks(
    tenant_digest,revoked_through_epoch
  ) VALUES(tenant_digest_value,revoked_epoch)
  ON CONFLICT(tenant_digest) DO UPDATE SET
    revoked_through_epoch=greatest(
      capability_internal.tenant_revocation_watermarks.revoked_through_epoch,
      excluded.revoked_through_epoch
    ),
    updated_at=clock_timestamp();
END;
$$;

-- Supersede every destructive entry point.  The reviewed deletion algorithms
-- remain unchanged behind wrappers, but deletion_rw can invoke them only after
-- a one-use token has been consumed in this transaction.
ALTER FUNCTION deletion_internal.purge_connection(text,text)
  RENAME TO purge_connection_pre_capability;
ALTER FUNCTION deletion_internal.purge_tenant(text)
  RENAME TO purge_tenant_pre_capability;
ALTER FUNCTION deletion_internal.verify_connection(text,text)
  RENAME TO verify_connection_pre_capability;
ALTER FUNCTION deletion_internal.verify_tenant(text)
  RENAME TO verify_tenant_pre_capability;

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_pre_capability(text,text),
  deletion_internal.purge_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text),
  deletion_internal.verify_tenant_pre_capability(text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;

CREATE FUNCTION deletion_internal.purge_connection(p_tenant_id text,p_connection_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_purge');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope'<>'connection'
     OR evidence->>'connection_id' IS DISTINCT FROM p_connection_id THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  PERFORM capability_internal.record_tenant_revocation(p_tenant_id);
  RETURN deletion_internal.purge_connection_pre_capability(p_tenant_id,p_connection_id);
END;
$$;

CREATE FUNCTION deletion_internal.purge_tenant(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_purge');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope'<>'tenant' OR evidence->'connection_id'<>'null'::jsonb THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  PERFORM capability_internal.record_tenant_revocation(p_tenant_id);
  RETURN deletion_internal.purge_tenant_pre_capability(p_tenant_id);
END;
$$;

CREATE FUNCTION deletion_internal.verify_connection(p_tenant_id text,p_connection_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_verify');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope'<>'connection'
     OR evidence->>'connection_id' IS DISTINCT FROM p_connection_id THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  RETURN deletion_internal.verify_connection_pre_capability(p_tenant_id,p_connection_id);
END;
$$;

CREATE FUNCTION deletion_internal.verify_tenant(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_verify');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope'<>'tenant' OR evidence->'connection_id'<>'null'::jsonb THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  RETURN deletion_internal.verify_tenant_pre_capability(p_tenant_id);
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA capability_internal
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection(text,text),
  deletion_internal.purge_tenant(text),
  deletion_internal.verify_connection(text,text),
  deletion_internal.verify_tenant(text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
REVOKE ALL ON FUNCTION core.current_tenant_id(),ingestion.current_tenant_id()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.current_tenant_id()
  TO ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION ingestion.current_tenant_id()
  TO ingest_rw,transform_rw,diagnostic_ro,deletion_rw;
-- Runtime roles need schema lookup only for the narrow readiness and deletion
-- activation entry points below. Tables and token verification internals remain
-- entirely inaccessible.
GRANT USAGE ON SCHEMA capability_internal
  TO ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION capability_internal.assert_verifier_ready()
  TO ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION capability_internal.activate_deletion_capability(text)
  TO deletion_rw;
GRANT USAGE ON SCHEMA deletion_internal TO deletion_rw;
GRANT EXECUTE ON FUNCTION
  deletion_internal.purge_connection(text,text),
  deletion_internal.purge_tenant(text),
  deletion_internal.verify_connection(text,text),
  deletion_internal.verify_tenant(text)
TO deletion_rw;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA capability_internal
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA deletion_internal
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
