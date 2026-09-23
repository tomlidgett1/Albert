/**
 * Albert partner session broker (ADR 0144).
 *
 * A partner product (Yellow Jersey first) embeds Albert's conversational
 * analytics by calling Albert's own web API server-to-server as a bearer
 * client. This function is the only place that turns a partner's API key
 * into that bearer token:
 *
 *   partner key (Authorization: Bearer albert_pk_…)
 *     → SHA-256, matched against ALBERT_PARTNER_CLIENTS (never the key itself)
 *     → magic-link mint for the client's acting member (GoTrue admin only)
 *     → the session must resolve to the client's bound tenant, or it is revoked
 *     → { accessToken, expiresAt } — no refresh token ever leaves this function
 *
 * The service-role key is used for GoTrue's admin API and nothing else: it
 * reads no control-plane table (service_role has no control_plane grants since
 * 0172). Every Albert RPC the partner then triggers runs under the acting
 * member's own policies, exactly like the iMessage bridge (ADR 0120/0121).
 *
 * Deploy: supabase functions deploy partner-session --no-verify-jwt
 *           --project-ref jjiugnriaypjoxsupjft
 */
import { createClient } from "npm:@supabase/supabase-js@2.112.0";

type PartnerClient = Readonly<{
  /** Stable id for logs and revocation, e.g. "yellow-jersey-ashburton". */
  clientId: string;
  /** The partner product, e.g. "yellow-jersey". */
  partner: string;
  /** Lowercase hex SHA-256 of the full partner key. */
  keySha256: string;
  /** The Albert tenant every session for this client must resolve to. */
  tenantId: string;
  /** The Albert member the partner acts as (auth.users id). */
  actingUserId: string;
  enabled: boolean;
}>;

const PARTNER_KEY_PATTERN = /^albert_pk_[A-Za-z0-9_-]{43}$/u;
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

class BrokerConfigurationError extends Error {}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

function parseClient(value: unknown, index: number): PartnerClient {
  const entry = value as Record<string, unknown> | null;
  const fail = (field: string) => {
    throw new BrokerConfigurationError(`ALBERT_PARTNER_CLIENTS[${index}].${field} is invalid.`);
  };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("entry");
  const { clientId, partner, keySha256, tenantId, actingUserId, enabled } = entry!;
  if (typeof clientId !== "string" || !CLIENT_ID_PATTERN.test(clientId)) fail("clientId");
  if (typeof partner !== "string" || !CLIENT_ID_PATTERN.test(partner)) fail("partner");
  if (typeof keySha256 !== "string" || !HEX_SHA256_PATTERN.test(keySha256)) fail("keySha256");
  if (typeof tenantId !== "string" || !ULID_PATTERN.test(tenantId)) fail("tenantId");
  if (typeof actingUserId !== "string" || !UUID_PATTERN.test(actingUserId)) fail("actingUserId");
  if (typeof enabled !== "boolean") fail("enabled");
  return Object.freeze({
    clientId: clientId as string,
    partner: partner as string,
    keySha256: keySha256 as string,
    tenantId: tenantId as string,
    actingUserId: actingUserId as string,
    enabled: enabled as boolean,
  });
}

function loadClients(): readonly PartnerClient[] {
  const raw = Deno.env.get("ALBERT_PARTNER_CLIENTS")?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrokerConfigurationError("ALBERT_PARTNER_CLIENTS is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new BrokerConfigurationError("ALBERT_PARTNER_CLIENTS must be an array.");
  const clients = parsed.map(parseClient);
  if (new Set(clients.map(({ clientId }) => clientId)).size !== clients.length) {
    throw new BrokerConfigurationError("ALBERT_PARTNER_CLIENTS has duplicate client ids.");
  }
  if (new Set(clients.map(({ keySha256 }) => keySha256)).size !== clients.length) {
    throw new BrokerConfigurationError("ALBERT_PARTNER_CLIENTS reuses a key digest.");
  }
  return clients;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length lowercase hex digests. */
function digestsEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function partnerKey(authorization: string | null): string | null {
  const match = /^Bearer (\S+)$/iu.exec(authorization?.trim() ?? "");
  const key = match?.[1] ?? "";
  return PARTNER_KEY_PATTERN.test(key) ? key : null;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new BrokerConfigurationError(`${name} is not configured.`);
  return value;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = partnerKey(request.headers.get("authorization"));
  if (!key) return json({ error: "invalid_partner_key" }, 401);

  let clients: readonly PartnerClient[];
  let supabaseUrl: string;
  let serviceKey: string;
  let anonKey: string;
  try {
    clients = loadClients();
    supabaseUrl = requiredEnv("SUPABASE_URL");
    serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    anonKey = requiredEnv("SUPABASE_ANON_KEY");
  } catch (error) {
    log("partner_session_misconfigured", { detail: error instanceof Error ? error.message : "unknown" });
    return json({ error: "broker_unavailable" }, 503);
  }

  const digest = await sha256Hex(key);
  // Every entry is compared so the match position never shapes the timing.
  let client: PartnerClient | undefined;
  for (const candidate of clients) {
    if (digestsEqual(candidate.keySha256, digest) && !client) client = candidate;
  }
  if (!client || !client.enabled) {
    log("partner_session_rejected", {
      reason: client ? "client_disabled" : "unknown_key",
      ...(client ? { clientId: client.clientId } : {}),
    });
    return json({ error: "invalid_partner_key" }, 401);
  }

  const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  const admin = createClient(supabaseUrl, serviceKey, { auth: noSession });
  try {
    const member = await admin.auth.admin.getUserById(client.actingUserId);
    const email = member.data.user?.email;
    if (member.error || !email) throw new Error(`acting member lookup failed: ${member.error?.message ?? "no email"}`);

    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link.data.properties?.hashed_token;
    if (link.error || !tokenHash) throw new Error(`sign-in link failed: ${link.error?.message ?? "no token"}`);

    const verifier = createClient(supabaseUrl, anonKey, { auth: noSession });
    const verified = await verifier.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
    const session = verified.data.session;
    if (verified.error || !session?.access_token || !session.expires_at) {
      throw new Error(`session verification failed: ${verified.error?.message ?? "no session"}`);
    }
    if (session.user?.id !== client.actingUserId) throw new Error("session belongs to a different member");

    // The session is only handed out if Albert resolves it to the bound
    // tenant: a member who switched organisations must never route a
    // partner's questions into another tenant's data.
    const scoped = createClient(supabaseUrl, anonKey, {
      auth: noSession,
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    });
    const context = await scoped.rpc("current_albert_context");
    const row = Array.isArray(context.data) ? context.data[0] : context.data;
    const resolvedTenant = row && typeof row === "object" ? (row as { tenant_id?: unknown }).tenant_id : undefined;
    if (context.error || resolvedTenant !== client.tenantId) {
      await admin.auth.admin.signOut(session.access_token, "local").catch(() => undefined);
      log("partner_session_tenant_mismatch", {
        clientId: client.clientId,
        tenantId: client.tenantId,
        resolved: typeof resolvedTenant === "string" ? resolvedTenant : null,
        rpcError: context.error?.code ?? null,
      });
      return json({ error: "tenant_mismatch" }, 409);
    }

    log("partner_session_minted", {
      clientId: client.clientId,
      partner: client.partner,
      tenantId: client.tenantId,
      actingUserId: client.actingUserId,
      expiresAt: session.expires_at,
    });
    return json({
      accessToken: session.access_token,
      tokenType: "bearer",
      expiresAt: session.expires_at,
      tenantId: client.tenantId,
      clientId: client.clientId,
    }, 200);
  } catch (error) {
    log("partner_session_failed", {
      clientId: client.clientId,
      detail: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    });
    return json({ error: "broker_unavailable" }, 503);
  }
});
