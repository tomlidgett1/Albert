/**
 * Discover (ADR 0130): thirty questions worth asking, keyed to the tools the
 * business has connected.
 *
 *   GET  → the tenant's cached cards while the fingerprint (connected tools,
 *          business-context revision, library version) still matches;
 *          otherwise the deterministic library so the grid paints at once.
 *   POST → personalise the library with Luna over the business context,
 *          persist per tenant and return. { refresh: true } discards the
 *          cache first so the owner can ask for fresh ideas.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadAgentConfig } from "@/packages/albert-v3/src/agent-config/loader";
import { CONNECTOR_LABELS } from "@/packages/albert-v3/src/engine/orchestrator";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import { loadBusinessContext } from "@/services/control-plane/src/business-context-repository";
import { loadDiscoverCache, saveDiscoverCache } from "@/services/control-plane/src/discover-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  loadConnectorRouting,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  DISCOVER_CARD_MINIMUM,
  DISCOVER_LIBRARY_VERSION,
  normaliseDiscoverConnectors,
  selectDiscoverCards,
  type DiscoverCard,
  type DiscoverConnector,
} from "@/services/discover/src/library";
import { DISCOVER_MODEL, synthesizeDiscoverCards, type DiscoverDataArea } from "@/services/discover/src/synthesize";

export const maxDuration = 90;

const logger = createServiceLogger("albert-discover-web");

type Source = "cache" | "library" | "model" | "empty";

function json(body: unknown, correlationId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, correlationId, status);
}

export function discoverFingerprint(input: Readonly<{
  connectors: readonly string[];
  contextRevision: string | null;
}>): string {
  return createHash("sha256")
    .update([
      DISCOVER_LIBRARY_VERSION,
      [...input.connectors].sort().join(","),
      input.contextRevision ?? "",
    ].join("|"))
    .digest("hex");
}

async function loadContext() {
  const auth = await requireUser();
  const tenant = await currentTenantContext();
  if (!tenant) throw new ControlPlaneError("Create your organisation before using Albert.", 409);
  const [routing, context, cache] = await Promise.all([
    loadConnectorRouting(auth.supabase).catch(() => undefined),
    loadBusinessContext(auth.supabase).catch(() => null),
    loadDiscoverCache(auth.supabase).catch(() => null),
  ]);
  const connectorKeys = routing?.activeConnectors ?? [];
  const connectors = normaliseDiscoverConnectors(connectorKeys);
  return {
    auth,
    tenant,
    connectors,
    library: selectDiscoverCards(connectorKeys),
    cache,
    fingerprint: discoverFingerprint({ connectors, contextRevision: context?.updatedAt ?? null }),
    businessContext: context?.rendered ?? `A small business named ${tenant.tenant_name}.`,
  };
}

type Loaded = Awaited<ReturnType<typeof loadContext>>;

function payload(loaded: Loaded, cards: readonly DiscoverCard[], source: Source, generatedAt?: string) {
  return {
    cards,
    connectors: loaded.connectors,
    business: loaded.tenant.tenant_name,
    source,
    fingerprint: loaded.fingerprint,
    ...(generatedAt ? { generatedAt } : {}),
  };
}

function cacheIsCurrent(loaded: Loaded): boolean {
  return Boolean(
    loaded.cache
    && loaded.cache.sourceFingerprint === loaded.fingerprint
    && loaded.cache.cards.length >= DISCOVER_CARD_MINIMUM,
  );
}

/** The governed data areas each connected tool exposes, for the model's grounding. */
function dataAreasFor(connectors: readonly DiscoverConnector[]): readonly DiscoverDataArea[] {
  const config = loadAgentConfig();
  return connectors.map((connector) => Object.freeze({
    connector,
    label: CONNECTOR_LABELS[connector] ?? connector,
    areas: Object.freeze(config.accessibleViews
      .filter((view) => view.connector === connector && !/source_explorer|source_fields|metafield/u.test(view.name))
      .map((view) => `${view.name.replace(/_analytics$/u, "").replace(/_/gu, " ")}: ${(view.purpose ?? view.guidance).replace(/\s+/gu, " ").slice(0, 140)}`)),
  }));
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const loaded = await loadContext();
    if (loaded.connectors.length === 0) return json(payload(loaded, [], "empty"), correlationId);
    if (cacheIsCurrent(loaded)) {
      return json(payload(loaded, loaded.cache!.cards, "cache", loaded.cache!.generatedAt), correlationId);
    }
    return json(payload(loaded, loaded.library, "library"), correlationId);
  } catch (error) {
    logger.error("discover.get_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "Discover could not be loaded.", status, correlationId);
  }
}

const postSchema = z.object({
  refresh: z.boolean().optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const body = await readBoundedJsonBody(request).catch(() => ({}));
    const parsed = postSchema.safeParse(body ?? {});
    const refresh = parsed.success ? Boolean(parsed.data.refresh) : false;
    const loaded = await loadContext();
    if (loaded.connectors.length === 0) return json(payload(loaded, [], "empty"), correlationId);
    if (!refresh && cacheIsCurrent(loaded)) {
      return json(payload(loaded, loaded.cache!.cards, "cache", loaded.cache!.generatedAt), correlationId);
    }

    const decision = await consumeAlbertRateLimit("conversation.discover_prompts");
    if (!decision.allowed) return rateLimitExceededResponse(decision);

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    let cards: readonly DiscoverCard[] | null = null;
    if (apiKey) {
      const started = Date.now();
      try {
        cards = await synthesizeDiscoverCards({
          businessContext: loaded.businessContext,
          connected: loaded.connectors,
          dataAreas: dataAreasFor(loaded.connectors),
          seeds: loaded.library,
          apiKey,
          baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
          safetyIdentifier: createHash("sha256")
            .update(`${loaded.tenant.tenant_id}:${loaded.auth.user.id}`)
            .digest("hex"),
          signal: request.signal,
        });
        logger.info("discover.synthesized", {
          tenantId: loaded.tenant.tenant_id,
          cards: cards?.length ?? 0,
          durationMs: Date.now() - started,
          refresh,
        }, correlationId);
      } catch (error) {
        logger.warn("discover.synthesize_failed", safeErrorEvidence(error), correlationId);
        cards = null;
      }
    }

    if (cards) {
      const stored = await saveDiscoverCache({
        sourceFingerprint: loaded.fingerprint,
        cards,
        model: DISCOVER_MODEL,
      }, loaded.auth.supabase).catch((error: unknown) => {
        logger.warn("discover.save_failed", safeErrorEvidence(error), correlationId);
        return null;
      });
      return json(payload(loaded, stored?.cards ?? cards, "model", stored?.generatedAt), correlationId);
    }
    return json(payload(loaded, loaded.library, "library"), correlationId);
  } catch (error) {
    logger.error("discover.post_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "Discover could not be refreshed.", status, correlationId);
  }
}
