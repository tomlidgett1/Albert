/**
 * Dashboard Master panel read: the latest completed daily report, any running
 * session, and whether the viewer can refresh. The report document is what
 * the tab renders; refreshDue drives the 24-hour auto-refresh.
 */
import {
  DASHBOARD_MASTER_REFRESH_AFTER_MS,
} from "@/services/dashboard-master/src/contracts";
import { loadDashboardMasterPanel } from "@/services/control-plane/src/dashboard-master-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-dashboard-master-web");

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using the dashboard.", 409, correlationId);
    const panel = await loadDashboardMasterPanel();
    const completedAt = panel.latest?.completedAt ? Date.parse(panel.latest.completedAt) : null;
    const refreshDue = !panel.running && (
      completedAt === null || Number.isNaN(completedAt)
      || Date.now() - completedAt > DASHBOARD_MASTER_REFRESH_AFTER_MS
    );
    return Response.json({
      latest: panel.latest,
      running: panel.running,
      conversationIds: panel.conversationIds,
      refreshDue,
      canRun: tenant.role === "owner" || tenant.role === "manager",
    }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    logger.error("dashboard_master.panel_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The dashboard could not be loaded.",
      status,
      correlationId,
    );
  }
}
