/**
 * Apply a finished build turn's composed plan to a dashboard (ADR 0129,
 * ADR 0134). Reads the plan and its governed tables from the persisted
 * conversation trace — never from a client payload — then drives the
 * existing tile RPCs. A whole build clears the dashboard and pins every
 * planned tile into a packed layout; an element edit replaces one tile in
 * the slot it held. `albert_dashboard_pin` independently re-verifies every
 * table's replay reference, so only replayable governed results can ever
 * become tiles.
 */
import { z } from "zod";
import {
  dashboardBuildApplyRequestSchema,
  displayFromPlanTile,
  packDashboardLayouts,
  replaceTileInLayouts,
  type DashboardPlanTile,
} from "@/services/dashboard-build/src/contracts";
import { loadDashboardBuildArtifacts, type DashboardBuildTable } from "@/services/dashboard-build/src/trace";
import {
  DashboardRevisionConflict,
  deleteDashboardTile,
  linkDashboardConversation,
  loadDashboard,
  pinDashboardTile,
  renameDashboard,
  replaceDashboardElement,
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

type Planned = Readonly<{ tile: DashboardPlanTile; table: DashboardBuildTable }>;

/** Pins one planned tile and applies its title + display; null when skipped. */
async function placeTile(
  dashboard: DashboardDocument,
  planned: Planned,
  source: Readonly<{ conversationId: string; turnId: string }>,
  skipped: string[],
): Promise<Readonly<{ dashboard: DashboardDocument; tileId: string | null }>> {
  let next = dashboard;
  try {
    next = await pinDashboardTile({
      conversationId: source.conversationId,
      turnId: source.turnId,
      tableEventId: planned.table.tableEventId,
      resultId: planned.table.resultId,
      expectedRevision: next.revision,
      dashboardId: next.dashboardId,
    });
  } catch (error) {
    if (error instanceof DashboardRevisionConflict) throw error;
    skipped.push(`"${planned.tile.title}": ${error instanceof ControlPlaneError ? error.message : "it could not be pinned."}`);
    return { dashboard: next, tileId: null };
  }
  const minted = next.tiles.find((candidate) => candidate.source.tableEventId === planned.table.tableEventId);
  if (!minted) {
    skipped.push(`"${planned.tile.title}": the pinned tile could not be found.`);
    return { dashboard: next, tileId: null };
  }
  next = await updateDashboardTile({
    tileId: minted.tileId,
    expectedRevision: next.revision,
    title: planned.tile.title,
    display: displayFromPlanTile(planned.tile),
    dashboardId: next.dashboardId,
  });
  return { dashboard: next, tileId: minted.tileId };
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
    const planned: Planned[] = plan.tiles.flatMap((tile) => {
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
      logger.warn("dashboard_build.nothing_replayable", {
        tenantId: tenant.tenant_id,
        conversationId: parsed.conversationId,
        turnId: parsed.turnId,
        skipped,
      }, correlationId);
      return jsonError(
        "None of the composed elements can refresh on a dashboard — they were built by a calculation Albert cannot re-run (a total, an anti-join, or a source with more than 50 rows). Ask again for the governed figures themselves, for example one row per day from each topic.",
        409,
        correlationId,
      );
    }

    let dashboard: DashboardDocument = await loadDashboard(parsed.dashboardId);
    const source = { conversationId: parsed.conversationId, turnId: parsed.turnId };
    let appliedCount = 0;
    let replacedTileId: string | null = null;
    let newTileId: string | null = null;

    if (parsed.replaceTileId) {
      // Element edit: the first replayable planned tile takes the edited
      // tile's slot; anything else the architect composed is not applied.
      const previous = dashboard.tiles.find((tile) => tile.tileId === parsed.replaceTileId);
      if (!previous) {
        return jsonError("The element being edited is no longer on the dashboard.", 409, correlationId);
      }
      const [replacement, ...extra] = planned;
      for (const entry of extra) {
        skipped.push(`"${entry.tile.title}": only the edited element was replaced.`);
      }
      // One RPC (migration 0187): delete, pin, title + display, the old slot
      // on both breakpoints and the conversation link, atomically. The
      // layouts name the replacement by a placeholder the server fills in.
      const replaced = await replaceDashboardElement({
        dashboardId: dashboard.dashboardId,
        replaceTileId: previous.tileId,
        conversationId: source.conversationId,
        turnId: source.turnId,
        tableEventId: replacement!.table.tableEventId,
        resultId: replacement!.table.resultId,
        title: replacement!.tile.title,
        display: displayFromPlanTile(replacement!.tile),
        layouts: replaceTileInLayouts(
          dashboard.layouts,
          { tileId: previous.tileId, display: previous.display },
          { tileId: "__replacement__", kind: replacement!.tile.kind, width: replacement!.tile.width },
        ),
        expectedRevision: dashboard.revision,
      });
      dashboard = replaced.dashboard;
      appliedCount = 1;
      replacedTileId = previous.tileId;
      newTileId = replaced.newTileId;
    } else {
      // Replace semantics: the plan is the whole dashboard. The architect saw
      // the previous tiles in its brief, so anything worth keeping was rebuilt.
      for (const tile of [...dashboard.tiles]) {
        dashboard = await deleteDashboardTile(tile.tileId, dashboard.revision, dashboard.dashboardId);
      }
      const applied: {
        tileId: string;
        kind: DashboardPlanTile["kind"];
        width: DashboardPlanTile["width"];
      }[] = [];
      for (const entry of planned) {
        const placed = await placeTile(dashboard, entry, source, skipped);
        dashboard = placed.dashboard;
        if (placed.tileId) applied.push({ tileId: placed.tileId, kind: entry.tile.kind, width: entry.tile.width });
      }
      if (applied.length === 0) {
        return jsonError("No tiles could be applied from the build.", 409, correlationId);
      }
      dashboard = await updateDashboardLayouts(
        packDashboardLayouts(applied),
        dashboard.revision,
        dashboard.dashboardId,
      );
      try {
        // The architect names the dashboard; keep that name on the document.
        // Best-effort: a database that predates the rename RPC keeps the
        // applied tiles either way.
        dashboard = await renameDashboard(plan.dashboardTitle, dashboard.revision, dashboard.dashboardId);
      } catch (error) {
        if (error instanceof DashboardRevisionConflict) throw error;
        logger.warn("dashboard_build.rename_skipped", safeErrorEvidence(error), correlationId);
      }
      appliedCount = applied.length;
    }

    if (!replacedTileId) try {
      // The dashboard remembers the conversation that built it, so opening it
      // later resumes the same thread. Best-effort on a pre-0186 database.
      dashboard = await linkDashboardConversation({
        conversationId: parsed.conversationId,
        expectedRevision: dashboard.revision,
        dashboardId: dashboard.dashboardId,
      });
    } catch (error) {
      if (error instanceof DashboardRevisionConflict) throw error;
      logger.warn("dashboard_build.link_skipped", safeErrorEvidence(error), correlationId);
    }

    logger.info("dashboard_build.applied", {
      tenantId: tenant.tenant_id,
      dashboardId: dashboard.dashboardId,
      conversationId: parsed.conversationId,
      turnId: parsed.turnId,
      tiles: appliedCount,
      skipped: skipped.length,
      ...(replacedTileId ? { replacedTileId } : {}),
    }, correlationId);
    return Response.json({
      dashboard,
      applied: {
        dashboardId: dashboard.dashboardId,
        dashboardTitle: replacedTileId ? (dashboard.title ?? plan.dashboardTitle) : plan.dashboardTitle,
        timeframe: plan.timeframe,
        tiles: appliedCount,
        skipped,
        ...(replacedTileId ? { replacedTileId } : {}),
        ...(newTileId ? { newTileId } : {}),
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
