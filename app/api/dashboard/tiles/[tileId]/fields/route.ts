/**
 * The fields an element's editor can add (ADR 0134): the measures and
 * dimensions of the governed view behind the element, plus what the query
 * already shows. Read from the shared catalogue cache; the catalogue is the
 * model's public surface, so a tenant-scoped token is all /v1/meta needs.
 */
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { CubeClient } from "@/packages/albert-v3/src/cube/client";
import type { CubeQuery } from "@/packages/albert-v3/src/cube/types";
import { loadDashboard } from "@/services/control-plane/src/dashboard-repository";
import { ControlPlaneError, currentTenantContext } from "@/services/control-plane/src/web-repository";
import { cachedCatalogue } from "@/services/dashboard/src/catalogue-cache";
import { dashboardElementFields } from "@/services/dashboard/src/element-fields";

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const NO_STORE = { "Cache-Control": "no-store" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryView(query: CubeQuery): string | null {
  const first = query.measures?.[0] ?? query.dimensions?.[0] ?? query.timeDimensions?.[0]?.dimension;
  return first && first.includes(".") ? first.split(".")[0]! : null;
}

export async function GET(request: Request, context: { params: Promise<{ tileId: string }> }) {
  try {
    const tileId = ulid.parse((await context.params).tileId);
    const dashboardId = ulid.optional().parse(new URL(request.url).searchParams.get("dashboardId") ?? undefined);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409, headers: NO_STORE });
    const dashboard = await loadDashboard(dashboardId);
    const tile = dashboard.tiles.find((candidate) => candidate.tileId === tileId);
    if (!tile) return Response.json({ error: "That element is no longer on the dashboard." }, { status: 404, headers: NO_STORE });
    if (tile.replayKind !== "cube_v3" || !tile.queryYaml) {
      return Response.json({ error: "This element has no governed query to add fields from." }, { status: 409, headers: NO_STORE });
    }
    const parsed = loadYaml(tile.queryYaml);
    if (!isRecord(parsed)) return Response.json({ error: "This element's query could not be read." }, { status: 409, headers: NO_STORE });
    const query = parsed as CubeQuery;
    const viewName = queryView(query);
    const apiUrl = process.env.CUBE_API_URL?.trim();
    const apiSecret = process.env.CUBEJS_API_SECRET?.trim();
    if (!viewName || !apiUrl || !apiSecret) {
      return Response.json({ error: "The governed model is unavailable." }, { status: 503, headers: NO_STORE });
    }
    const catalogue = await cachedCatalogue(apiUrl, new CubeClient({
      apiUrl,
      apiSecret,
      securityContext: { tenant_id: tenant.tenant_id },
    }));
    const view = catalogue.views.find((candidate) => candidate.name === viewName);
    if (!view) return Response.json({ error: "This element's topic is no longer in the governed model." }, { status: 409, headers: NO_STORE });
    const members = dashboardElementFields(view);
    return Response.json({
      view: {
        name: view.name,
        title: view.title,
        ...(view.queryPolicy ? { queryPolicy: view.queryPolicy } : {}),
        ...(view.minimumTimeGranularity ? { minimumTimeGranularity: view.minimumTimeGranularity } : {}),
      },
      inQuery: {
        measures: [...(query.measures ?? [])],
        dimensions: [...(query.dimensions ?? [])],
        timeDimensions: (query.timeDimensions ?? []).map((entry) => ({
          dimension: entry.dimension,
          ...(entry.granularity ? { granularity: entry.granularity } : {}),
          ...(entry.dateRange ? { dateRange: entry.dateRange } : {}),
          ...(entry.compareDateRange ? { compareDateRange: entry.compareDateRange } : {}),
        })),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      },
      members,
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "A valid element is required." }, { status: 400, headers: NO_STORE });
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({
      error: error instanceof ControlPlaneError ? error.message : "The element's fields could not be loaded.",
    }, { status, headers: NO_STORE });
  }
}
