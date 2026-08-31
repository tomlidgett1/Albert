/**
 * Apply a finished build turn's composed plan to the dashboard (ADR 0129).
 * Reads the plan and its governed tables from the persisted conversation
 * trace — never from a client payload — then drives the existing tile RPCs:
 * clear, pin, title + display, packed layout. `albert_dashboard_pin`
 * independently re-verifies every table's replay reference, so only
 * replayable governed results can ever become tiles.
 */
import { z } from "zod";
import {
  dashboardBuildApplyRequestSchema,
  displayFromPlanTile,
  packDashboardLayouts,
} from "@/services/dashboard-build/src/contracts";
import { loadDashboardBuildArtifacts } from "@/services/dashboard-build/src/trace";
import {
  DashboardRevisionConflict,
  deleteDashboardTile,
  loadDashboard,
  pinDashboardTile,
  updateDashboardLayouts,
  updateDashboardTile,
  type DashboardDocument,
} from "@/services/control-plane/src/dashboard-repository";
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

export const maxDuration = 120;

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
    const rateLimit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    const parsed = dashboardBuildApplyRequestSchema.parse(await readBoundedJsonBody(request));

    const { plan, tablesByResultId } = await loadDashboardBuildArtifacts(parsed);
    const skipped: string[] = [];
    const planned = plan.tiles.flatMap((tile) => {
      const table = tablesByResultId.get(tile.resultId);
      if (!table) {
        skipped.push(`"${tile.title}": its governed result was not persisted.`);
        return [];
      }
      if (!table.replayable) {
        skipped.push(`"${tile.title}": its table has no replay reference.`);
        return [];
      }
      return [{ tile, table }];
    });
    if (planned.length === 0) {
      return jsonError("None of the planned tiles are replayable, so nothing was applied.", 409, correlationId);
    }

    // Replace semantics: the plan is the whole dashboard. The architect saw
    // the previous tiles in its brief, so anything worth keeping was rebuilt.
    let dashboard: DashboardDocument = await loadDashboard();
    for (const tile of [...dashboard.tiles]) {
      dashboard = await deleteDashboardTile(tile.tileId, dashboard.revision);
    }

    const applied: {
      tileId: string;
      kind: "kpi" | "chart" | "table";
      width: "quarter" | "third" | "half" | "twoThirds" | "full";
    }[] = [];
    for (const { tile, table } of planned) {
      try {
        dashboard = await pinDashboardTile({
          conversationId: parsed.conversationId,
          turnId: parsed.turnId,
          tableEventId: table.tableEventId,
          resultId: table.resultId,
          expectedRevision: dashboard.revision,
        });
      } catch (error) {
        if (error instanceof DashboardRevisionConflict) throw error;
        skipped.push(`"${tile.title}": ${error instanceof ControlPlaneError ? error.message : "it could not be pinned."}`);
        continue;
      }
      const minted = dashboard.tiles.find((candidate) => candidate.source.tableEventId === table.tableEventId);
      if (!minted) {
        skipped.push(`"${tile.title}": the pinned tile could not be found.`);
        continue;
      }
      dashboard = await updateDashboardTile({
        tileId: minted.tileId,
        expectedRevision: dashboard.revision,
        title: tile.title,
        display: displayFromPlanTile(tile),
      });
      applied.push({ tileId: minted.tileId, kind: tile.kind, width: tile.width });
    }
    if (applied.length === 0) {
      return jsonError("No tiles could be applied from the build.", 409, correlationId);
    }

    dashboard = await updateDashboardLayouts(
      packDashboardLayouts(applied),
      dashboard.revision,
    );

    logger.info("dashboard_build.applied", {
      tenantId: tenant.tenant_id,
      conversationId: parsed.conversationId,
      turnId: parsed.turnId,
      tiles: applied.length,
      skipped: skipped.length,
    }, correlationId);
    return Response.json({
      dashboard,
      applied: {
        dashboardTitle: plan.dashboardTitle,
        timeframe: plan.timeframe,
        tiles: applied.length,
        skipped,
      },
    }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid dashboard apply request.", 400, correlationId);
    if (error instanceof DashboardRevisionConflict) {
      return jsonError("The dashboard changed in another tab while applying; try the build again.", 409, correlationId);
    }
    logger.error("dashboard_build.apply_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The dashboard build could not be applied.",
      status,
      correlationId,
    );
  }
}
