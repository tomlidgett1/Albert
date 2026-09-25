/**
 * Compose the Dashboard Master report from the session's findings and
 * complete the session. Luna at max effort over the full evidence set, so
 * this is the long route of the family. A compose failure marks the session
 * failed rather than leaving it wedged in "running".
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { dashboardSessionStateSchema } from "@/services/dashboard-master/src/contracts";
import { composeDashboardReport } from "@/services/dashboard-master/src/compose";
import {
  completeDashboardMasterSession,
  failDashboardMasterSession,
  loadDashboardMasterPanel,
} from "@/services/control-plane/src/dashboard-master-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

export const maxDuration = 800;

const logger = createServiceLogger("albert-dashboard-master-web");

const bodySchema = z.object({
  reportId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
}).strict();

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
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using the dashboard.", 409, correlationId);
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return jsonError("Only owners and managers can refresh the dashboard.", 403, correlationId);
    }
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return jsonError("The dashboard is not configured on this environment.", 503, correlationId);

    const panel = await loadDashboardMasterPanel();
    if (!panel.running || panel.running.reportId !== parsed.reportId) {
      return jsonError("That dashboard session is no longer running.", 409, correlationId);
    }
    const state = dashboardSessionStateSchema.parse(panel.running.sessionState ?? {});
    if (state.phase !== "compose") {
      return jsonError("The dashboard session is not ready to compose.", 409, correlationId);
    }
    try {
      const report = await composeDashboardReport({
        state,
        periodLabel: state.periodLabel,
        businessName: tenant.tenant_name ?? "the business",
        transport: {
          apiKey,
          baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
          safetyIdentifier: createHash("sha256")
            .update(`${tenant.tenant_id}:${auth.user.id}`)
            .digest("hex"),
        },
      });
      const stored = await completeDashboardMasterSession({ reportId: parsed.reportId, report });
      logger.info("dashboard_master.report_composed", {
        tenantId: tenant.tenant_id,
        reportId: parsed.reportId,
        focus: report.focus.length,
        cautions: report.cautions.length,
      }, correlationId);
      return Response.json({ latest: stored }, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    } catch (composeError) {
      await failDashboardMasterSession({
        reportId: parsed.reportId,
        note: composeError instanceof Error ? composeError.message.slice(0, 300) : "compose failed",
      }).catch(() => undefined);
      throw composeError;
    }
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid dashboard compose request.", 400, correlationId);
    logger.error("dashboard_master.compose_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The dashboard report could not be composed.",
      status,
      correlationId,
    );
  }
}
