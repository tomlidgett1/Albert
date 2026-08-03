BEGIN;

-- A tenant deletion deliberately removes the tenant anchor and every
-- membership. Keep only this user-bound, non-tenant receipt so the requesting
-- human can observe the durable job after access is suspended and can retain
-- the hash-only completion proof after the tenant row is gone. The table has
-- no tenant id, organisation name, source identifier, or customer payload.
CREATE TABLE IF NOT EXISTS control_plane.tenant_deletion_receipts (
  deletion_request_id text PRIMARY KEY
    CHECK (control_plane.is_ulid(deletion_request_id)),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN (
    'awaiting_approval','queued','running','retry_wait','verifying',
    'failed','completed','cancelled'
  )),
  requested_at timestamptz NOT NULL,
  approved_at timestamptz,
  purge_due_at timestamptz,
  completed_at timestamptz,
  proof_id text UNIQUE CHECK (proof_id IS NULL OR control_plane.is_ulid(proof_id)),
  proof_digest text UNIQUE
    CHECK (proof_digest IS NULL OR proof_digest ~ '^[a-f0-9]{64}$'),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{1,119}$'
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL
      AND proof_id IS NOT NULL AND proof_digest IS NOT NULL)
    OR status <> 'completed'
  )
);

-- The compatibility runner removes the source-level Auth reference before the
-- isolated migration owner executes this migration. Install that one exact
-- constraint through the protected, no-argument administrator capability.
SELECT extensions.albert_install_tenant_deletion_receipt_auth_reference();

COMMENT ON TABLE control_plane.tenant_deletion_receipts IS
  'User-bound, privacy-minimised status/proof receipt retained outside the deleted tenant anchor. It contains no tenant identifier, name, source data, or customer payload.';

CREATE INDEX IF NOT EXISTS tenant_deletion_receipts_user_updated_idx
  ON control_plane.tenant_deletion_receipts (requested_by, updated_at DESC);

ALTER TABLE control_plane.tenant_deletion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.tenant_deletion_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE control_plane.tenant_deletion_receipts
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_operator_diagnostic_control,
       albert_deletion_control;

DROP POLICY IF EXISTS migration_owner_tenant_deletion_receipt_access
  ON control_plane.tenant_deletion_receipts;
CREATE POLICY migration_owner_tenant_deletion_receipt_access
  ON control_plane.tenant_deletion_receipts
  FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);

-- Deletion-request mutations are already constrained to the reviewed public
-- RPCs and the deletion-worker lease routines. Mirror their privacy-safe state
-- through an owner-only trigger rather than granting a runtime direct access
-- to this receipt table.
CREATE OR REPLACE FUNCTION control_plane.sync_tenant_deletion_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.scope <> 'tenant' OR NEW.requested_by IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO control_plane.tenant_deletion_receipts (
    deletion_request_id, requested_by, status, requested_at, approved_at,
    purge_due_at, completed_at, proof_id, last_error_code, updated_at
  ) VALUES (
    NEW.deletion_request_id, NEW.requested_by, NEW.status, NEW.requested_at,
    NEW.approved_at, NEW.purge_due_at, NEW.completed_at, NEW.proof_id,
    NEW.last_error_code, clock_timestamp()
  )
  ON CONFLICT (deletion_request_id) DO UPDATE SET
    status = EXCLUDED.status,
    approved_at = EXCLUDED.approved_at,
    purge_due_at = EXCLUDED.purge_due_at,
    completed_at = EXCLUDED.completed_at,
    proof_id = coalesce(EXCLUDED.proof_id,
      control_plane.tenant_deletion_receipts.proof_id),
    last_error_code = EXCLUDED.last_error_code,
    updated_at = clock_timestamp()
  WHERE control_plane.tenant_deletion_receipts.requested_by = EXCLUDED.requested_by;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant deletion receipt ownership mismatch'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deletion_requests_sync_user_receipt
  ON control_plane.deletion_requests;
CREATE TRIGGER deletion_requests_sync_user_receipt
  AFTER INSERT OR UPDATE ON control_plane.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION control_plane.sync_tenant_deletion_receipt();

-- The immutable proof is inserted before a completed tenant request and its
-- tenant anchor are deleted. This trigger makes that exact proof observable to
-- the original requester without adding a user id to the global proof ledger.
CREATE OR REPLACE FUNCTION control_plane.complete_tenant_deletion_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.scope = 'tenant' THEN
    UPDATE control_plane.tenant_deletion_receipts
    SET status = 'completed',
        completed_at = NEW.completed_at,
        proof_id = NEW.proof_id,
        proof_digest = NEW.proof_digest,
        last_error_code = NULL,
        updated_at = clock_timestamp()
    WHERE deletion_request_id = NEW.deletion_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tenant deletion receipt is missing'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deletion_proofs_complete_user_receipt
  ON control_plane.deletion_proofs;
CREATE TRIGGER deletion_proofs_complete_user_receipt
  AFTER INSERT ON control_plane.deletion_proofs
  FOR EACH ROW EXECUTE FUNCTION control_plane.complete_tenant_deletion_receipt();

-- Upgrade any in-flight tenant request before the trigger starts maintaining
-- it. Completed historical tenant requests cannot be relinked by design: their
-- proof ledger intentionally retained no user identifier.
INSERT INTO control_plane.tenant_deletion_receipts (
  deletion_request_id, requested_by, status, requested_at, approved_at,
  purge_due_at, completed_at, proof_id, last_error_code, updated_at
)
SELECT request.deletion_request_id, request.requested_by, request.status,
       request.requested_at, request.approved_at, request.purge_due_at,
       request.completed_at, request.proof_id, request.last_error_code,
       clock_timestamp()
FROM control_plane.deletion_requests AS request
WHERE request.scope = 'tenant' AND request.requested_by IS NOT NULL
ON CONFLICT (deletion_request_id) DO NOTHING;

CREATE OR REPLACE FUNCTION control_plane.tenant_deletion_receipt_json(
  p_deletion_request_id text,
  p_requested_by uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'deletionRequestId', receipt.deletion_request_id,
    'status', receipt.status,
    'requestedAt', receipt.requested_at,
    'approvedAt', receipt.approved_at,
    'purgeDueAt', receipt.purge_due_at,
    'completedAt', receipt.completed_at,
    'lastErrorCode', receipt.last_error_code,
    'proof', CASE WHEN proof.proof_id IS NULL THEN NULL ELSE jsonb_build_object(
      'proofId', proof.proof_id,
      'proofDigest', proof.proof_digest,
      'completedAt', proof.completed_at,
      'remoteRevocation', proof.remote_revocation,
      'storeVerification', proof.store_verification,
      'serviceVersion', proof.service_version
    ) END
  )
  FROM control_plane.tenant_deletion_receipts AS receipt
  LEFT JOIN control_plane.deletion_proofs AS proof
    ON proof.deletion_request_id = receipt.deletion_request_id
   AND proof.scope = 'tenant'
  WHERE receipt.deletion_request_id = p_deletion_request_id
    AND receipt.requested_by = p_requested_by;
$$;

CREATE OR REPLACE FUNCTION public.albert_tenant_deletion_receipt(
  p_deletion_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT control_plane.is_ulid(p_deletion_request_id) THEN
    RAISE EXCEPTION 'deletion request is invalid' USING ERRCODE = '22023';
  END IF;
  result := control_plane.tenant_deletion_receipt_json(
    p_deletion_request_id, actor
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_albert_tenant_deletion_receipt()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_request text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT receipt.deletion_request_id INTO selected_request
  FROM control_plane.tenant_deletion_receipts AS receipt
  WHERE receipt.requested_by = actor
  ORDER BY
    CASE WHEN receipt.status IN (
      'awaiting_approval','queued','running','retry_wait','verifying','failed'
    ) THEN 0 ELSE 1 END,
    receipt.updated_at DESC,
    receipt.deletion_request_id DESC
  LIMIT 1;
  IF selected_request IS NULL THEN RETURN NULL; END IF;
  RETURN control_plane.tenant_deletion_receipt_json(selected_request, actor);
END;
$$;

-- Context and deletion state must share one statement snapshot. Otherwise an
-- approval that commits between two web RPCs can expose stale active context
-- while hiding the newly queued receipt. A post-approval receipt deliberately
-- dominates any other active organisation until erasure reaches a terminal
-- state; an awaiting request remains managed inside organisation settings.
CREATE OR REPLACE FUNCTION public.current_albert_session_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  context_value jsonb;
  receipt_value jsonb;
  receipt_status text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT to_jsonb(context_row) INTO context_value
  FROM public.current_albert_context() AS context_row
  LIMIT 1;
  receipt_value := public.current_albert_tenant_deletion_receipt();
  receipt_status := receipt_value ->> 'status';
  IF receipt_status IN (
    'queued','running','retry_wait','verifying','failed'
  ) THEN
    context_value := NULL;
  ELSIF context_value IS NOT NULL THEN
    receipt_value := NULL;
  END IF;
  RETURN jsonb_build_object(
    'context', context_value,
    'deletionReceipt', receipt_value,
    'needsBootstrap', context_value IS NULL AND receipt_value IS NULL
  );
END;
$$;

-- Deletion request and every organisation-creation path take the same
-- transaction-scoped user lock. The lock is acquired before selecting active
-- context so a racing create cannot leave the request bound to stale context.
CREATE OR REPLACE FUNCTION public.albert_request_tenant_deletion(
  p_confirmation text
)
RETURNS TABLE (
  deletion_request_id text,
  status text,
  approval_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid := auth.uid();
  tenant_name text;
  generated_id text;
  rate_allowed boolean;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albert:tenant-bootstrap:' || actor::text, 0)
  );
  selected_tenant := control_plane.require_current_tenant_id();
  IF NOT control_plane.has_tenant_role(
    selected_tenant, ARRAY['owner']::text[]
  ) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE = '42501';
  END IF;
  SELECT allowed INTO rate_allowed
  FROM public.consume_albert_rate_limit('tenant.deletion_request', 3, 86400);
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT display_name INTO STRICT tenant_name
  FROM control_plane.tenants
  WHERE tenant_id = selected_tenant AND status = 'active'
  FOR UPDATE;
  IF p_confirmation IS DISTINCT FROM 'DELETE ' || tenant_name THEN
    RAISE EXCEPTION 'tenant deletion confirmation does not match'
      USING ERRCODE = '22023';
  END IF;
  generated_id := control_plane.generate_ulid();
  INSERT INTO control_plane.deletion_requests (
    tenant_id, deletion_request_id, scope, status, requested_by,
    remote_revocation_status, credential_destroyed_at, purge_due_at,
    approval_expires_at, progress
  ) VALUES (
    selected_tenant, generated_id, 'tenant', 'awaiting_approval', actor,
    'not_applicable', NULL, now(), now() + interval '30 minutes',
    jsonb_build_object('request', 'confirmed')
  );
  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'tenant.deletion_requested', 'deletion_request', generated_id,
    jsonb_build_object('approval_expires_at', now() + interval '30 minutes')
  );
  deletion_request_id := generated_id;
  status := 'awaiting_approval';
  approval_expires_at := now() + interval '30 minutes';
  RETURN NEXT;
END;
$$;

-- Preserve the concurrency-safe bootstrap invariant while refusing to create a
-- replacement organisation behind the user's back during a deletion. A later
-- explicit organisation-create action remains available after completion.
CREATE OR REPLACE FUNCTION public.bootstrap_albert_tenant(
  p_display_name text,
  p_timezone text
)
RETURNS TABLE (
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  existing_tenant text;
  created_tenant text;
  created_membership text;
  created_overlay text;
  normalized_name text := btrim(p_display_name);
  normalized_timezone text := btrim(p_timezone);
  generated_slug text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albert:tenant-bootstrap:' || actor::text, 0)
  );
  SELECT membership.tenant_id INTO existing_tenant
  FROM control_plane.memberships AS membership
  WHERE membership.user_id = actor AND membership.status = 'active'
  ORDER BY membership.created_at, membership.tenant_id
  LIMIT 1;
  IF existing_tenant IS NOT NULL THEN
    RETURN QUERY
      SELECT tenant.tenant_id, tenant.display_name, tenant.slug,
             membership.role,
             coalesce(overlay.overlay ->> 'timezone', 'Australia/Melbourne')
      FROM control_plane.tenants AS tenant
      JOIN control_plane.memberships AS membership
        ON membership.tenant_id = tenant.tenant_id
       AND membership.user_id = actor
       AND membership.status = 'active'
      LEFT JOIN LATERAL (
        SELECT candidate.overlay
        FROM control_plane.tenant_overlays AS candidate
        WHERE candidate.tenant_id = tenant.tenant_id
          AND candidate.status = 'published'
        ORDER BY candidate.version DESC
        LIMIT 1
      ) AS overlay ON true
      WHERE tenant.tenant_id = existing_tenant;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.tenant_deletion_receipts AS receipt
    WHERE receipt.requested_by = actor
      AND receipt.status IN (
        'awaiting_approval','queued','running','retry_wait','verifying','failed'
      )
  ) THEN
    RAISE EXCEPTION 'tenant deletion is still in progress'
      USING ERRCODE = '55000';
  END IF;
  IF normalized_name IS NULL OR length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = normalized_timezone
  ) THEN
    RAISE EXCEPTION 'timezone is not recognised' USING ERRCODE = '22023';
  END IF;
  created_tenant := control_plane.generate_ulid();
  created_membership := control_plane.generate_ulid();
  created_overlay := control_plane.generate_ulid();
  generated_slug := left(
    trim(both '-' FROM regexp_replace(lower(normalized_name), '[^a-z0-9]+', '-', 'g')),
    42
  );
  IF generated_slug = '' THEN generated_slug := 'organisation'; END IF;
  generated_slug := generated_slug || '-' || lower(right(created_tenant, 6));
  INSERT INTO control_plane.tenants (tenant_id, slug, display_name, status, created_by)
  VALUES (created_tenant, generated_slug, normalized_name, 'active', actor);
  INSERT INTO control_plane.memberships (
    tenant_id, membership_id, user_id, role, status, created_by
  ) VALUES (created_tenant, created_membership, actor, 'owner', 'active', actor);
  INSERT INTO control_plane.placement_registry (
    tenant_id, logical_cell_key, status, placement_metadata
  ) VALUES (
    created_tenant, 'cell_01', 'assigned', '{"region":"ap-southeast-2"}'::jsonb
  );
  INSERT INTO control_plane.tenant_overlays (
    tenant_id, overlay_id, version, status, overlay, change_reason,
    created_by, published_at
  ) VALUES (
    created_tenant, created_overlay, 1, 'published',
    jsonb_build_object(
      'timezone', normalized_timezone,
      'trading_day_cutoff', '00:00',
      'blocking_answers', '{}'::jsonb
    ),
    'Tenant bootstrap', actor, now()
  );
  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    created_tenant, control_plane.generate_ulid(), actor, 'user',
    'tenant.bootstrap', 'tenant', created_tenant,
    jsonb_build_object('timezone', normalized_timezone)
  );
  RETURN QUERY SELECT created_tenant, normalized_name, generated_slug,
    'owner'::text, normalized_timezone;
END;
$$;

-- The explicit multi-organisation path is also fenced until deletion reaches
-- a terminal state. Otherwise a direct caller could create a new active
-- context and make the in-flight receipt disappear from the session surface.
CREATE OR REPLACE FUNCTION public.albert_create_organisation(
  p_display_name text,
  p_timezone text
)
RETURNS TABLE (
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  normalized_name text:=btrim(p_display_name);
  normalized_timezone text:=btrim(p_timezone);
  created_tenant text:=control_plane.generate_ulid();
  created_membership text:=control_plane.generate_ulid();
  created_overlay text:=control_plane.generate_ulid();
  generated_slug text;
  rate_allowed boolean;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albert:tenant-bootstrap:' || actor::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM control_plane.tenant_deletion_receipts AS receipt
    WHERE receipt.requested_by=actor
      AND receipt.status IN (
        'awaiting_approval','queued','running','retry_wait','verifying','failed'
      )
  ) THEN
    RAISE EXCEPTION 'tenant deletion is still in progress'
      USING ERRCODE='55000';
  END IF;
  SELECT allowed INTO rate_allowed
  FROM public.consume_albert_rate_limit('organisation.create',5,86400);
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE='P0001';
  END IF;
  IF length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters'
      USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=normalized_timezone
  ) THEN
    RAISE EXCEPTION 'timezone is not recognised' USING ERRCODE='22023';
  END IF;
  generated_slug:=left(
    trim(both '-' FROM regexp_replace(lower(normalized_name),'[^a-z0-9]+','-','g')),
    42
  );
  IF generated_slug='' THEN generated_slug:='organisation'; END IF;
  generated_slug:=generated_slug||'-'||lower(right(created_tenant,6));
  INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status,created_by)
  VALUES(created_tenant,generated_slug,normalized_name,'active',actor);
  INSERT INTO control_plane.memberships(
    tenant_id,membership_id,user_id,role,status,created_by
  ) VALUES(created_tenant,created_membership,actor,'owner','active',actor);
  INSERT INTO control_plane.placement_registry(
    tenant_id,logical_cell_key,status,placement_metadata
  ) VALUES(
    created_tenant,'cell_01','assigned','{"region":"ap-southeast-2"}'::jsonb
  );
  INSERT INTO control_plane.tenant_overlays(
    tenant_id,overlay_id,version,status,overlay,change_reason,
    created_by,published_at
  ) VALUES (
    created_tenant,created_overlay,1,'published',jsonb_build_object(
      'timezone',normalized_timezone,
      'trading_day_cutoff','00:00',
      'blocking_answers','{}'::jsonb
    ),'Organisation created',actor,now()
  );
  INSERT INTO control_plane.user_active_tenants(user_id,tenant_id,selected_at)
  VALUES(actor,created_tenant,clock_timestamp())
  ON CONFLICT(user_id) DO UPDATE
    SET tenant_id=excluded.tenant_id,selected_at=excluded.selected_at;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    created_tenant,control_plane.generate_ulid(),actor,'user','tenant.created',
    'tenant',created_tenant,jsonb_build_object('timezone',normalized_timezone)
  );
  RETURN QUERY SELECT created_tenant,normalized_name,generated_slug,
    'owner'::text,normalized_timezone;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.sync_tenant_deletion_receipt()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_operator_diagnostic_control,
       albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.complete_tenant_deletion_receipt()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_operator_diagnostic_control,
       albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.tenant_deletion_receipt_json(text,uuid)
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_operator_diagnostic_control,
       albert_deletion_control;
REVOKE ALL ON FUNCTION public.albert_tenant_deletion_receipt(text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.current_albert_tenant_deletion_receipt()
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.current_albert_session_state()
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.albert_request_tenant_deletion(text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.bootstrap_albert_tenant(text,text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.albert_create_organisation(text,text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.albert_tenant_deletion_receipt(text),
  public.current_albert_tenant_deletion_receipt(),
  public.current_albert_session_state(),
  public.albert_request_tenant_deletion(text),
  public.bootstrap_albert_tenant(text,text),
  public.albert_create_organisation(text,text)
  TO authenticated;

COMMIT;
