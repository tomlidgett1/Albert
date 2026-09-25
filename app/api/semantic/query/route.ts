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
import { claimSemanticQueryLease } from "@/services/control-plane/src/semantic-query-repository";
import {
  cubeRuntime,
  partnerCatalogue,
  runBatch,
  semanticBatchSchema,
  validateBatch,
} from "@/services/dashboard/src/semantic-api";
import { requestBearerAccessToken } from "@/utils/supabase/server";

export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const MAX_BODY_BYTES = 128_000;
const PURPOSE = "partner.semantic";

/**
 * POST /api/semantic/query (ADR 0153)
 *
 * Runs a batch of up to 12 governed Cube JSON queries for the caller's tenant
 * and returns one result per query, in order. Each query is validated against
 * the live catalogue (a bad one fails alone); the batch runs under the
 * member's semantic query lease, which Cube trades for a tenant capability,
 * so row-level security isolates the tenant inside Postgres. Partner bearer
 * sessions only, owner or manager, rate limited per member.
 */
export async function POST(request: Request) {
  try {
    if (!(await requestBearerAccessToken())) {
      return Response.json({ error: "Partner API clients only.", code: "partner_only" }, { status: 403, headers: NO_STORE });
    }
    assertSameOriginMutation(request);
    const body = semanticBatchSchema.safeParse(await readBoundedJsonBody(request, MAX_BODY_BYTES));
    if (!body.success) {
      const issue = body.error.issues[0];
      return Response.json(
        { error: `The query batch is invalid${issue ? ` (${issue.path.join(".") || "body"}: ${issue.message})` : ""}.`, code: "query_invalid" },
        { status: 400, headers: NO_STORE },
      );
    }
    const [, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return Response.json({ error: "Organisation context is required.", code: "tenant_required" }, { status: 409, headers: NO_STORE });
    if (tenant.tenant_id !== body.data.expectedTenantId) {
      return Response.json({ error: "This session belongs to another organisation.", code: "tenant_mismatch" }, { status: 409, headers: NO_STORE });
    }
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return Response.json({ error: "Owner or manager access is required.", code: "role_forbidden" }, { status: 403, headers: NO_STORE });
    }
    const limit = await consumeAlbertRateLimit("semantic.query");
    if (!limit.allowed) return rateLimitExceededResponse(limit);

    const runtime = cubeRuntime();
    if (!runtime) return Response.json({ error: "The semantic layer is unavailable.", code: "cube_unavailable" }, { status: 503, headers: NO_STORE });
    const { catalogue } = await partnerCatalogue(runtime, tenant.tenant_id);
    const checked = validateBatch(body.data.queries, catalogue);
    if (checked.every((entry) => "error" in entry)) {
      return Response.json({
        tenantId: tenant.tenant_id,
        results: checked.map((entry) => ({ ok: false, code: "query_invalid", error: "error" in entry ? entry.error : "" })),
      }, { headers: NO_STORE });
    }

    const lease = await claimSemanticQueryLease(tenant.tenant_id, PURPOSE);
    const started = Date.now();
    const results = await runBatch(runtime, { tenantId: tenant.tenant_id, role: lease.role, leaseId: lease.leaseId }, checked);
    console.info("Albert semantic query batch", {
      tenantId: tenant.tenant_id,
      leaseId: lease.leaseId,
      queries: results.length,
      failed: results.filter((result) => !result.ok).length,
      ms: Date.now() - started,
    });
    return Response.json({ tenantId: tenant.tenant_id, leaseId: lease.leaseId, results }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    console.error("Albert semantic query failed", { message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return Response.json({ error: "The semantic layer is unavailable.", code: "cube_unavailable" }, { status: 503, headers: NO_STORE });
  }
}
