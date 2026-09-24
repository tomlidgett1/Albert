/**
 * Albert partner provisioning (ADR 0151).
 *
 * A partner product (Yellow Jersey first) provisions one Albert tenant per
 * account it serves, server to server, with a platform key:
 *
 *   platform key (Authorization: Bearer albert_pp_…)
 *     → SHA-256, matched against ALBERT_PARTNER_PLATFORMS (never the key)
 *     → acting member: an auth user with a deterministic id and an
 *       undeliverable address, created with the GoTrue admin API
 *     → tenant: created BY that member through albert_create_organisation,
 *       exactly as a person would (owner membership, overlay, active tenant)
 *     → partner client: control_plane.partner_clients with the key digest the
 *       partner sent. The partner generates and keeps the key; only its
 *       SHA-256 ever reaches Albert, and partner-session accepts it from then on.
 *
 * Idempotent per (partner, accountRef): a retry reuses the member and tenant
 * it already created, and a new digest for an active client rotates its key.
 * `disable` switches a client off (its tenant and data are untouched).
 *
 * The service-role key is used for the GoTrue admin API and the partner RPCs
 * (0195, service_role only). Tenant creation runs under the acting member's
 * own session, so no control-plane table is written with elevated rights.
 *
 * Deploy: supabase functions deploy partner-provision --no-verify-jwt
 *           --project-ref jjiugnriaypjoxsupjft
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.112.0";
import {
  actingMemberEmail,
  actingMemberId,
  bearerKey,
  clientIdFor,
  matchPlatform,
  parsePlatformRequest,
  parsePlatforms,
  PLATFORM_KEY_PATTERN,
  PlatformConfigurationError,
  sha256Hex,
  type PartnerPlatform,
  type ProvisionRequest,
} from "./core.ts";

const MAX_BODY_BYTES = 8 * 1024;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

class ProvisionError extends Error {
  constructor(readonly code: string, readonly status: number, detail?: string) {
    super(detail ?? code);
  }
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new PlatformConfigurationError(`${name} is not configured.`);
  return value;
}

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

type ClientRow = {
  client_id: string;
  acting_user_id: string;
  tenant_id: string | null;
  key_sha256: string | null;
  token_broker: boolean;
  status: "provisioning" | "active" | "disabled";
};

function firstRow<T>(data: unknown): T | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as T : null;
}

async function rpc<T>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T | null> {
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    if (error.code === "P0002") throw new ProvisionError("not_found", 404);
    if (error.code === "55000") throw new ProvisionError("client_conflict", 409, error.message);
    if (error.code === "23505") throw new ProvisionError("key_in_use", 409);
    if (error.code === "42501") throw new ProvisionError("tenant_ownership_mismatch", 409);
    throw new ProvisionError("provisioning_failed", 503, `${name}: ${error.code ?? "unknown"} ${error.message}`);
  }
  return firstRow<T>(data);
}

/** The acting member exists with this id (created now or by an earlier attempt). */
async function ensureActingMember(
  admin: SupabaseClient,
  userId: string,
  email: string,
  platform: PartnerPlatform,
  request: ProvisionRequest,
): Promise<void> {
  const existing = await admin.auth.admin.getUserById(userId);
  if (existing.data.user) {
    if (existing.data.user.email?.toLowerCase() !== email) {
      throw new ProvisionError("acting_member_mismatch", 409);
    }
    return;
  }
  const created = await admin.auth.admin.createUser({
    id: userId,
    email,
    email_confirm: true,
    app_metadata: { albert_partner: platform.partner, albert_partner_account: request.accountRef },
    user_metadata: { display_name: `${request.displayName} (${platform.partner})` },
  });
  if (created.error || !created.data.user) {
    throw new ProvisionError("acting_member_failed", 503, created.error?.message ?? "no user");
  }
  if (created.data.user.id !== userId) {
    // GoTrue ignored the requested id: never leave an orphan behind.
    await admin.auth.admin.deleteUser(created.data.user.id).catch(() => undefined);
    throw new ProvisionError("acting_member_failed", 503, "requested user id was not honoured");
  }
}

/** A short-lived session for the acting member (the broker's magic-link mint). */
async function memberSession(
  admin: SupabaseClient,
  supabaseUrl: string,
  anonKey: string,
  userId: string,
  email: string,
): Promise<string> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data.properties?.hashed_token;
  if (link.error || !tokenHash) throw new ProvisionError("member_session_failed", 503, link.error?.message);
  const verifier = createClient(supabaseUrl, anonKey, { auth: noSession });
  const verified = await verifier.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  const session = verified.data.session;
  if (verified.error || !session?.access_token || session.user?.id !== userId) {
    throw new ProvisionError("member_session_failed", 503, verified.error?.message ?? "no session");
  }
  return session.access_token;
}

/**
 * The member's own tenant: reuse the one an earlier attempt created, or create
 * it through albert_create_organisation under the member's session.
 */
async function memberTenant(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
  request: ProvisionRequest,
): Promise<string> {
  const scoped = createClient(supabaseUrl, anonKey, {
    auth: noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const context = await scoped.rpc("current_albert_context");
  const current = firstRow<{ tenant_id?: unknown; role?: unknown }>(context.data);
  if (!context.error && typeof current?.tenant_id === "string" && current.role === "owner") {
    return current.tenant_id;
  }
  const created = await scoped.rpc("albert_create_organisation", {
    p_display_name: request.displayName,
    p_timezone: request.timezone,
  });
  const row = firstRow<{ tenant_id?: unknown }>(created.data);
  if (created.error || typeof row?.tenant_id !== "string" || !ULID_PATTERN.test(row.tenant_id)) {
    const code = created.error?.code === "22023" ? "invalid_request" : "tenant_create_failed";
    throw new ProvisionError(code, code === "invalid_request" ? 400 : 503, created.error?.message);
  }
  return row.tenant_id;
}

async function provision(
  admin: SupabaseClient,
  supabaseUrl: string,
  anonKey: string,
  platform: PartnerPlatform,
  request: ProvisionRequest,
): Promise<Response> {
  const activateArgs = (tenantId: string) => ({
    p_partner: platform.partner,
    p_account_ref: request.accountRef,
    p_tenant_id: tenantId,
    p_key_sha256: request.keySha256,
    p_token_broker: request.tokenBroker,
  });
  const existing = await rpc<ClientRow>(admin, "albert_partner_client_for_account", {
    p_partner: platform.partner,
    p_account_ref: request.accountRef,
  });
  if (existing?.status === "active" && existing.tenant_id) {
    // Already provisioned: converge on the digest and broker flag sent now.
    let rotated = false;
    if (existing.key_sha256 !== request.keySha256 || existing.token_broker !== request.tokenBroker) {
      const updated = await rpc<{ key_rotated?: boolean }>(admin, "albert_partner_activate_client", activateArgs(existing.tenant_id));
      rotated = updated?.key_rotated === true;
    }
    return json({
      clientId: existing.client_id,
      tenantId: existing.tenant_id,
      actingUserId: existing.acting_user_id,
      tokenBroker: request.tokenBroker,
      status: "active",
      created: false,
      keyRotated: rotated,
    }, 200);
  }

  const clientId = existing?.client_id ?? clientIdFor(platform.partner, request.accountRef);
  const actingUserId = existing?.acting_user_id ?? await actingMemberId(platform.partner, request.accountRef);
  const email = actingMemberEmail(clientId);
  await ensureActingMember(admin, actingUserId, email, platform, request);
  const reserved = await rpc<ClientRow>(admin, "albert_partner_reserve_client", {
    p_partner: platform.partner,
    p_account_ref: request.accountRef,
    p_client_id: clientId,
    p_display_name: request.displayName,
    p_acting_user_id: actingUserId,
  });
  if (!reserved || reserved.acting_user_id !== actingUserId) {
    throw new ProvisionError("client_conflict", 409, "the account is bound to another member");
  }

  const accessToken = await memberSession(admin, supabaseUrl, anonKey, actingUserId, email);
  try {
    const tenantId = reserved.tenant_id ?? await memberTenant(supabaseUrl, anonKey, accessToken, request);
    const activated = await rpc<ClientRow>(admin, "albert_partner_activate_client", activateArgs(tenantId));
    if (!activated || activated.status !== "active") throw new ProvisionError("provisioning_failed", 503, "activation");
    log("partner_client_provisioned", {
      partner: platform.partner,
      clientId: reserved.client_id,
      tenantId,
      actingUserId,
      tokenBroker: request.tokenBroker,
    });
    return json({
      clientId: reserved.client_id,
      tenantId,
      actingUserId,
      tokenBroker: request.tokenBroker,
      status: "active",
      created: true,
      keyRotated: false,
    }, 201);
  } finally {
    // The provisioning session is single-use: nothing else ever holds it.
    await admin.auth.admin.signOut(accessToken, "local").catch(() => undefined);
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = bearerKey(request.headers.get("authorization"), PLATFORM_KEY_PATTERN);
  if (!key) return json({ error: "invalid_platform_key" }, 401);

  let platforms: readonly PartnerPlatform[];
  let supabaseUrl: string;
  let serviceKey: string;
  let anonKey: string;
  try {
    platforms = parsePlatforms(Deno.env.get("ALBERT_PARTNER_PLATFORMS"));
    supabaseUrl = requiredEnv("SUPABASE_URL");
    serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    anonKey = requiredEnv("SUPABASE_ANON_KEY");
  } catch (error) {
    log("partner_provision_misconfigured", { detail: error instanceof Error ? error.message : "unknown" });
    return json({ error: "provisioning_unavailable" }, 503);
  }

  const platform = matchPlatform(platforms, await sha256Hex(key));
  if (!platform || !platform.enabled) {
    log("partner_provision_rejected", { reason: platform ? "platform_disabled" : "unknown_key" });
    return json({ error: "invalid_platform_key" }, 401);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: "request_too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const parsed = parsePlatformRequest(body);
  if (!parsed) return json({ error: "invalid_request" }, 400);

  const admin = createClient(supabaseUrl, serviceKey, { auth: noSession });
  try {
    if (parsed.action === "disable") {
      const disabled = await rpc<{ client_id: string; tenant_id: string | null; status: string }>(
        admin,
        "albert_partner_disable_client",
        { p_partner: platform.partner, p_account_ref: parsed.accountRef },
      );
      log("partner_client_disabled", { partner: platform.partner, clientId: disabled?.client_id ?? null });
      return json({ clientId: disabled?.client_id ?? null, tenantId: disabled?.tenant_id ?? null, status: "disabled" }, 200);
    }
    return await provision(admin, supabaseUrl, anonKey, platform, parsed);
  } catch (error) {
    const failure = error instanceof ProvisionError
      ? error
      : new ProvisionError("provisioning_failed", 503, error instanceof Error ? error.message : "unknown");
    log("partner_provision_failed", {
      partner: platform.partner,
      action: parsed.action,
      code: failure.code,
      detail: failure.message.slice(0, 300),
    });
    return json({ error: failure.code }, failure.status);
  }
});
