import { z } from "zod";
import { loadAgentConfig } from "@/packages/albert-v3/src/agent-config/loader";
import {
  claimDashboardRefresh,
  completeDashboardRefresh,
  loadDashboard,
} from "@/services/control-plane/src/dashboard-repository";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  loadConnectionsWorkspace,
} from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";
import { refreshDashboardClaim } from "@/services/dashboard/src/refresh";

export const maxDuration = 180;

const requestSchema = z.object({
  tileIds: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).min(1).max(24).optional(),
  force: z.boolean().default(false),
}).strict();

async function inBatches<T>(items: readonly T[], width: number, task: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += width) {
    await Promise.all(items.slice(index, index + width).map(task));
  }
}

function currentWatermarks(workspace: unknown, connector: string | null | undefined): readonly unknown[] {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return [];
  const providers = (workspace as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((provider) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [];
    const row = provider as Record<string, unknown>;
    if (connector && row.id !== connector) return [];
    const connections = Array.isArray(row.connections) ? row.connections : [];
    return connections.flatMap((connection) => {
      if (!connection || typeof connection !== "object" || Array.isArray(connection)) return [];
      const domains = (connection as Record<string, unknown>).domains;
      if (!Array.isArray(domains)) return [];
      return domains.flatMap((domain) => {
        if (!domain || typeof domain !== "object" || Array.isArray(domain)) return [];
        const watermark = (domain as Record<string, unknown>).watermark;
        if (!watermark || typeof watermark !== "object" || Array.isArray(watermark)) return [];
        const at = (watermark as Record<string, unknown>).at;
        return typeof at === "string" ? [{ connector: row.id, label: row.name, dataThrough: at }] : [];
      });
    });
  });
}

function currentCurrency(workspace: unknown): string | undefined {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return undefined;
  const dossier = (workspace as Record<string, unknown>).dossier;
  if (!Array.isArray(dossier)) return undefined;
  const value = dossier.find((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).id === "base_currency"
  );
  const currency = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).value
    : undefined;
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    const limit = await consumeAlbertRateLimit("dashboard.refresh");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const parsed = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid refresh request is required." }, { status: 400 });
    const claims = await claimDashboardRefresh(parsed.data);
    const connections = await loadConnectionsWorkspace().catch(() => null);
    await inBatches(claims, 4, async (claim) => {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const result = await refreshDashboardClaim(
        claim,
        tenant,
        currentWatermarks(connections, claim.recipe.kind === "cube_v3" ? claim.recipe.connector : null),
        currentCurrency(connections) ?? loadAgentConfig().currency,
      );
      await completeDashboardRefresh({
        tileId: claim.tileId,
        claimedAt: claim.claimedAt,
        leaseId: claim.leaseId,
        outcome: result.outcome,
        startedAt,
        latencyMs: Date.now() - started,
        snapshot: result.snapshot,
        resultDigest: result.resultDigest,
        rowCount: result.rowCount,
        sourceWatermarks: result.sourceWatermarks,
        adapter: claim.replayKind,
        dedupeStatus: result.dedupeStatus,
        errorCode: result.errorCode,
        adapterMetadata: result.metadata,
      });
    });
    return Response.json({ dashboard: await loadDashboard(), refreshedTileIds: claims.map(({ tileId }) => tileId) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The dashboard could not be refreshed.";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
