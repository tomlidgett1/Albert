-- 0195: partner provisioning and partner-brokered grants (ADR 0151).
--
-- A partner product (Yellow Jersey) provisions one Albert tenant per store it
-- serves, server to server: a synthetic acting member, the tenant (created by
-- that member through albert_create_organisation, the same path a person
-- takes), and a partner client whose key digest the partner-session broker
-- accepts. Until now partner clients lived only in the ALBERT_PARTNER_CLIENTS
-- edge secret (ADR 0144), one manual secret edit per store. That secret keeps
-- working (Ashburton); this table is the registry for provisioned stores.
--
-- Partner-brokered grants: Lightspeed, Xero and Deputy refresh tokens are
-- single-use and rotating, so each grant may have exactly one refresher. For
-- a provisioned store that refresher is the partner. The sync worker asks the
-- partner's token broker for a current access token (token_broker = true)
-- instead of copying the grant into Albert's vault. The worker reads only the
-- broker binding columns; key digests stay behind the service_role RPCs.
--
-- Access posture: private table, RLS on, no customer grants. The
-- partner-session and partner-provision edge functions reach it only through
-- the SECURITY DEFINER RPCs below, executable by service_role alone.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.partner_clients (
  client_id text PRIMARY KEY CHECK (client_id ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  partner text NOT NULL CHECK (partner ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  -- The partner's own id for the account (Yellow Jersey: the store owner's user id).
  partner_account_ref text NOT NULL
    CHECK (partner_account_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  -- The acting member's Supabase Auth user id. No foreign key: Auth references
  -- are installed only by the administrator helper (0042), like
  -- fivetran_connections.authorised_by.
  acting_user_id uuid NOT NULL,
  tenant_id text REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  -- Lowercase hex SHA-256 of the partner key. The key itself never reaches Albert.
  key_sha256 text CHECK (key_sha256 IS NULL OR key_sha256 ~ '^[0-9a-f]{64}$'),
  token_broker boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  provisioned_at timestamptz,
  disabled_at timestamptz,
  UNIQUE (partner, partner_account_ref),
  CHECK (status <> 'active' OR (tenant_id IS NOT NULL AND key_sha256 IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_clients_key_sha256_unique
  ON control_plane.partner_clients (key_sha256)
  WHERE key_sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partner_clients_acting_user_unique
  ON control_plane.partner_clients (acting_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS partner_clients_live_tenant_unique
  ON control_plane.partner_clients (tenant_id)
  WHERE tenant_id IS NOT NULL AND status <> 'disabled';

ALTER TABLE control_plane.partner_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE control_plane.partner_clients
  FROM PUBLIC, anon, authenticated, service_role;

-- The sync worker resolves a tenant's broker binding (who refreshes its
-- grants). Column grant: the key digest is not part of it.
GRANT SELECT (client_id, partner, partner_account_ref, tenant_id, status, token_broker)
  ON TABLE control_plane.partner_clients TO albert_sync_control;
DROP POLICY IF EXISTS sync_runtime_broker_read ON control_plane.partner_clients;
CREATE POLICY sync_runtime_broker_read ON control_plane.partner_clients
  FOR SELECT TO albert_sync_control
  USING (status = 'active' AND token_broker);

COMMENT ON TABLE control_plane.partner_clients IS
  'Partner API clients provisioned server to server (ADR 0151): acting member, tenant, key digest, and whether the partner brokers the tenant''s vendor grants. Private; service_role RPCs and the sync worker''s broker binding read only.';

-- One live Fivetran connection per (tenant, service) for partner-brokered
-- grants, the partner-side twin of fivetran_connections_native_live_unique:
-- a concurrent duplicate registration fails its insert and converges on the
-- surviving row.
CREATE UNIQUE INDEX IF NOT EXISTS fivetran_connections_partner_live_unique
  ON control_plane.fivetran_connections (tenant_id, service)
  WHERE status IN ('connected', 'degraded', 'blocked')
    AND account_metadata ? 'partnerClientId';

-- partner-session: the client a key digest belongs to (env clients first).
CREATE OR REPLACE FUNCTION public.albert_partner_client_by_digest(p_key_sha256 text)
RETURNS TABLE(
  client_id text,
  partner text,
  tenant_id text,
  acting_user_id uuid,
  enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT client.client_id,
         client.partner,
         client.tenant_id,
         client.acting_user_id,
         client.status = 'active'
    FROM control_plane.partner_clients AS client
   WHERE p_key_sha256 ~ '^[0-9a-f]{64}$'
     AND client.key_sha256 = p_key_sha256
     AND client.tenant_id IS NOT NULL
     AND client.status IN ('active', 'disabled');
$$;

-- partner-provision: the client for a partner account, if any.
CREATE OR REPLACE FUNCTION public.albert_partner_client_for_account(
  p_partner text,
  p_account_ref text
)
RETURNS TABLE(
  client_id text,
  acting_user_id uuid,
  tenant_id text,
  key_sha256 text,
  token_broker boolean,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT client.client_id,
         client.acting_user_id,
         client.tenant_id,
         client.key_sha256,
         client.token_broker,
         client.status
    FROM control_plane.partner_clients AS client
   WHERE client.partner = p_partner
     AND client.partner_account_ref = p_account_ref;
$$;

-- partner-provision: create (or revive) the client row before its tenant
-- exists. Idempotent per (partner, account); an existing row keeps its client
-- id and acting member.
CREATE OR REPLACE FUNCTION public.albert_partner_reserve_client(
  p_partner text,
  p_account_ref text,
  p_client_id text,
  p_display_name text,
  p_acting_user_id uuid
)
RETURNS TABLE(
  client_id text,
  acting_user_id uuid,
  tenant_id text,
  key_sha256 text,
  token_broker boolean,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO control_plane.partner_clients AS client (
    client_id, partner, partner_account_ref, display_name, acting_user_id, status
  ) VALUES (
    p_client_id, p_partner, p_account_ref, btrim(p_display_name), p_acting_user_id, 'provisioning'
  )
  ON CONFLICT (partner, partner_account_ref) DO UPDATE
    SET display_name = excluded.display_name,
        status = CASE WHEN client.status = 'disabled' THEN 'provisioning' ELSE client.status END,
        disabled_at = CASE WHEN client.status = 'disabled' THEN NULL ELSE client.disabled_at END,
        updated_at = clock_timestamp();
  RETURN QUERY
    SELECT client.client_id, client.acting_user_id, client.tenant_id,
           client.key_sha256, client.token_broker, client.status
      FROM control_plane.partner_clients AS client
     WHERE client.partner = p_partner
       AND client.partner_account_ref = p_account_ref;
END;
$$;

-- partner-provision: bind the tenant the acting member created and (re)set the
-- key digest. The acting member must own the tenant; a client never moves to
-- another tenant.
CREATE OR REPLACE FUNCTION public.albert_partner_activate_client(
  p_partner text,
  p_account_ref text,
  p_tenant_id text,
  p_key_sha256 text,
  p_token_broker boolean
)
RETURNS TABLE(
  client_id text,
  acting_user_id uuid,
  tenant_id text,
  token_broker boolean,
  status text,
  key_rotated boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_row control_plane.partner_clients%ROWTYPE;
  rotated boolean;
  first_activation boolean;
BEGIN
  IF p_key_sha256 IS NULL OR p_key_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'partner key digest is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT control_plane.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO current_row
    FROM control_plane.partner_clients AS client
   WHERE client.partner = p_partner
     AND client.partner_account_ref = p_account_ref
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner client not found' USING ERRCODE = 'P0002';
  END IF;
  IF current_row.status = 'disabled' THEN
    RAISE EXCEPTION 'partner client is disabled' USING ERRCODE = '55000';
  END IF;
  IF current_row.tenant_id IS NOT NULL AND current_row.tenant_id <> p_tenant_id THEN
    RAISE EXCEPTION 'partner client belongs to another tenant' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM control_plane.memberships AS membership
      JOIN control_plane.tenants AS tenant ON tenant.tenant_id = membership.tenant_id
     WHERE membership.tenant_id = p_tenant_id
       AND membership.user_id = current_row.acting_user_id
       AND membership.role = 'owner'
       AND membership.status = 'active'
       AND tenant.status = 'active'
  ) THEN
    RAISE EXCEPTION 'acting member does not own the tenant' USING ERRCODE = '42501';
  END IF;
  rotated := current_row.key_sha256 IS NOT NULL AND current_row.key_sha256 <> p_key_sha256;
  first_activation := current_row.status <> 'active';
  UPDATE control_plane.partner_clients AS client
     SET tenant_id = p_tenant_id,
         key_sha256 = p_key_sha256,
         token_broker = coalesce(p_token_broker, false),
         status = 'active',
         provisioned_at = coalesce(client.provisioned_at, clock_timestamp()),
         updated_at = clock_timestamp()
   WHERE client.client_id = current_row.client_id;
  IF first_activation OR rotated OR current_row.token_broker IS DISTINCT FROM coalesce(p_token_broker, false) THEN
    INSERT INTO control_plane.audit_log (
      tenant_id, audit_id, actor_user_id, actor_type, action,
      resource_type, resource_id, audit_metadata
    ) VALUES (
      p_tenant_id, control_plane.generate_ulid(), current_row.acting_user_id, 'service',
      CASE WHEN first_activation THEN 'partner.client_provisioned' ELSE 'partner.client_updated' END,
      'partner_client', current_row.client_id,
      jsonb_build_object(
        'partner', current_row.partner,
        'tokenBroker', coalesce(p_token_broker, false),
        'keyRotated', rotated
      )
    );
  END IF;
  RETURN QUERY
    SELECT client.client_id, client.acting_user_id, client.tenant_id,
           client.token_broker, client.status, rotated
      FROM control_plane.partner_clients AS client
     WHERE client.client_id = current_row.client_id;
END;
$$;

-- partner-provision: switch a client off. Sessions already minted die at
-- their expiry (at most an hour); the tenant and its data are untouched.
CREATE OR REPLACE FUNCTION public.albert_partner_disable_client(
  p_partner text,
  p_account_ref text
)
RETURNS TABLE(client_id text, tenant_id text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_row control_plane.partner_clients%ROWTYPE;
BEGIN
  UPDATE control_plane.partner_clients AS client
     SET status = 'disabled',
         disabled_at = coalesce(client.disabled_at, clock_timestamp()),
         updated_at = clock_timestamp()
   WHERE client.partner = p_partner
     AND client.partner_account_ref = p_account_ref
  RETURNING * INTO current_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner client not found' USING ERRCODE = 'P0002';
  END IF;
  IF current_row.tenant_id IS NOT NULL THEN
    INSERT INTO control_plane.audit_log (
      tenant_id, audit_id, actor_user_id, actor_type, action,
      resource_type, resource_id, audit_metadata
    ) VALUES (
      current_row.tenant_id, control_plane.generate_ulid(), current_row.acting_user_id, 'service',
      'partner.client_disabled', 'partner_client', current_row.client_id,
      jsonb_build_object('partner', current_row.partner)
    );
  END IF;
  RETURN QUERY SELECT current_row.client_id, current_row.tenant_id, current_row.status;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_partner_client_by_digest(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.albert_partner_client_for_account(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.albert_partner_reserve_client(text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.albert_partner_activate_client(text, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.albert_partner_disable_client(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.albert_partner_client_by_digest(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.albert_partner_client_for_account(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.albert_partner_reserve_client(text, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.albert_partner_activate_client(text, text, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.albert_partner_disable_client(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
