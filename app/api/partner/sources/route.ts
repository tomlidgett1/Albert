import { z } from "zod";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { callWorker, OAuthFlowError } from "@/services/oauth/src/worker-rpc";
import { requestBearerAccessToken } from "@/utils/supabase/server";

/** Packaging and uploading an SDK connector plus Fivetran's setup can take minutes. */
export const maxDuration = 300;

/** The partner's grant name → Fivetran's service id (the worker path segment). */
const SERVICES = {
  lightspeed: "light_speed_retail",
  xero: "xero",
  deputy: "deputy",
} as const;

const bodySchema = z.object({
  provider: z.enum(["lightspeed", "xero", "deputy"]),
}).strict();

/**
 * POST /api/partner/sources (ADR 0151)
 *
 * A partner client (bearer session from partner-session, ADR 0144) registers
 * one of its tenant's sources as a partner-brokered Fivetran connection. The
 * grant stays with the partner, which keeps refreshing it; the worker creates
 * the Fivetran connection through the same start path Albert's own OAuth
 * hand-off uses and fetches every access token from the partner's broker.
 *
 * Idempotent: a repeat call returns the connection the grant already feeds.
 * Only tenants a partner provisioned with a token broker can register (the
 * worker checks the binding); everyone else is refused. Progress is read with
 * GET /api/connections/fivetran-status?connectionId=…
 */
export async function POST(request: Request) {
  try {
    // Partner API only: a browser session has Albert's own Connect flow.
    if (!(await requestBearerAccessToken())) {
      return Response.json({ error: "Partner API clients only." }, { status: 403 });
    }
    assertSameOriginMutation(request);
    const body = bodySchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A valid provider is required." }, { status: 400 });
    const [{ user }, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    if (!["owner", "manager"].includes(tenant.role)) {
      return Response.json({ error: "Owner or manager access is required." }, { status: 403 });
    }
    const limit = await consumeAlbertRateLimit("oauth.start");
    if (!limit.allowed) return rateLimitExceededResponse(limit);

    const service = SERVICES[body.data.provider];
    const result = await callWorker<{ connectionId: string; fivetranConnectionId: string }>(
      `/v1/fivetran/${service}/start`,
      { tenantId: tenant.tenant_id, userId: user.id, grantSource: "partner" },
    );
    return Response.json({
      provider: body.data.provider,
      service,
      connectionId: result.connectionId,
      fivetranConnectionId: result.fivetranConnectionId,
    }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof OAuthFlowError) {
      // The worker's code (for example fivetran_partner_grant_expired or
      // fivetran_setup_rejected) and detail are the partner's honest status.
      console.error("Albert partner source registration failed", {
        status: error.status,
        code: error.message,
        detail: error.detail?.slice(0, 200),
      });
      const status = error.status === 403 || error.status === 404 || error.status === 409 ? error.status : 502;
      return Response.json({ error: error.message, ...(error.detail ? { detail: error.detail } : {}) }, { status });
    }
    console.error("Albert partner source registration failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "The source could not be registered right now." }, { status: 502 });
  }
}
