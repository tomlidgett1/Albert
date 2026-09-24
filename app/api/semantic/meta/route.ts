import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { rateLimitExceededResponse } from "@/services/control-plane/src/request-security";
import { cubeRuntime, partnerCatalogue } from "@/services/dashboard/src/semantic-api";
import { requestBearerAccessToken } from "@/utils/supabase/server";

export const maxDuration = 60;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * GET /api/semantic/meta?expectedTenantId=<ULID> (ADR 0153)
 *
 * The governed views a partner client may query for its tenant: each view's
 * measures, dimensions and segments with their titles, types, formats and
 * the model's own guidance. Partner bearer sessions only; the caller names
 * the tenant it expects and a session bound to another organisation fails
 * closed.
 */
export async function GET(request: Request) {
  try {
    if (!(await requestBearerAccessToken())) {
      return Response.json({ error: "Partner API clients only.", code: "partner_only" }, { status: 403, headers: NO_STORE });
    }
    const expectedTenantId = new URL(request.url).searchParams.get("expectedTenantId") ?? "";
    if (!ULID.test(expectedTenantId)) {
      return Response.json({ error: "expectedTenantId is required.", code: "tenant_required" }, { status: 400, headers: NO_STORE });
    }
    const [, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return Response.json({ error: "Organisation context is required.", code: "tenant_required" }, { status: 409, headers: NO_STORE });
    if (tenant.tenant_id !== expectedTenantId) {
      return Response.json({ error: "This session belongs to another organisation.", code: "tenant_mismatch" }, { status: 409, headers: NO_STORE });
    }
    if (!["owner", "manager"].includes(tenant.role)) {
      return Response.json({ error: "Owner or manager access is required.", code: "role_forbidden" }, { status: 403, headers: NO_STORE });
    }
    const limit = await consumeAlbertRateLimit("semantic.query");
    if (!limit.allowed) return rateLimitExceededResponse(limit);

    const runtime = cubeRuntime();
    if (!runtime) return Response.json({ error: "The semantic layer is unavailable.", code: "cube_unavailable" }, { status: 503, headers: NO_STORE });
    const { catalogue, views } = await partnerCatalogue(runtime, tenant.tenant_id);
    return Response.json(
      { tenantId: tenant.tenant_id, timezone: tenant.timezone ?? null, fetchedAt: catalogue.fetchedAt, views },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    console.error("Albert semantic meta failed", { message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return Response.json({ error: "The semantic layer is unavailable.", code: "cube_unavailable" }, { status: 503, headers: NO_STORE });
  }
}
