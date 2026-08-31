/**
 * Start a natural-language dashboard build (ADR 0129). Owner/manager,
 * rate-limited. Composes the architect brief server-side — the owner's
 * instruction plus the current dashboard for refinement context — and
 * returns the message the browser runs through /api/omni-conversation with
 * `dashboardBuild: true`, the same browser-orchestrated shape as Proactive,
 * Swarm and Dashboard Master runs.
 */
import { z } from "zod";
import {
  DASHBOARD_BUILD_EFFORT,
  DASHBOARD_BUILD_FAST_MODE,
  DASHBOARD_BUILD_MODEL,
  buildDashboardBriefMessage,
  dashboardBuildRequestSchema,
} from "@/services/dashboard-build/src/contracts";
import { loadDashboard } from "@/services/control-plane/src/dashboard-repository";
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
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-dashboard-build-web");

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before building a dashboard.", 409, correlationId);
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return jsonError("Only owners and managers can build the dashboard.", 403, correlationId);
    }
    const rateLimit = await consumeAlbertRateLimit("dashboard.build");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    const parsed = dashboardBuildRequestSchema.parse(await readBoundedJsonBody(request));

    const dashboard = await loadDashboard();
    const message = buildDashboardBriefMessage({
      instruction: parsed.instruction,
      currentTiles: dashboard.tiles,
    });
    logger.info("dashboard_build.brief_composed", {
      tenantId: tenant.tenant_id,
      existingTiles: dashboard.tiles.length,
      instructionChars: parsed.instruction.length,
    }, correlationId);
    return Response.json({
      message,
      preferences: {
        model: DASHBOARD_BUILD_MODEL,
        reasoningEffort: DASHBOARD_BUILD_EFFORT,
        fastMode: DASHBOARD_BUILD_FAST_MODE,
      },
      replacesTiles: dashboard.tiles.length,
    }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid dashboard build request.", 400, correlationId);
    logger.error("dashboard_build.start_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The dashboard build could not be started.",
      status,
      correlationId,
    );
  }
}
