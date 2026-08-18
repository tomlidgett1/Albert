/**
 * Business context API (the business context layer, see
 * packages/albert-v3/src/context-layer and ADR 0098).
 *
 *   GET  → the tenant's stored document (or null), whether the caller can
 *          manage it, and whether a refresh from data is due.
 *   PUT  → owner edit: { document, ownerLocked } → saved (source=owner).
 *   POST → { action: "confirm" } | { action: "regenerate" }
 *          regenerate begins a short conversation turn (Cube needs a lease),
 *          collects the facts, generates the document, saves it (owner locks
 *          preserved) and ends the turn with a one-line answer event.
 */
import { ulid } from "ulid";
import { z } from "zod";
import { normalizeAgentPreferences, providerForModel } from "@/packages/shared/src";
import { ALBERT_V3_RUNTIME, businessContextDocumentSchema, BUSINESS_CONTEXT_SECTIONS, businessContextRefreshDue, runStandaloneBusinessContextRefresh } from "@/packages/albert-v3/src";
import { emptyTurnProvenance } from "@/packages/albert-v3/src/engine/grounding";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import { appendConversationEvent, assignConversationTitle, beginConversationTurn, failConversationTurn } from "@/services/conversation/src/artifact-store";
import { ControlPlaneError, currentTenantContext, loadConnectorRouting, loadSourceFindings, requireUser } from "@/services/control-plane/src/web-repository";
import { confirmBusinessContext, loadBusinessContext, saveBusinessContext } from "@/services/control-plane/src/business-context-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";

export const maxDuration = 300;

const logger = createServiceLogger("albert-business-context-web");

function json(body: unknown, status: number, correlationId: string): Response {
  return Response.json(body, { status, headers: { "x-request-id": correlationId, "Cache-Control": "no-store" } });
}
function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, status, correlationId);
}

async function authenticate(correlationId: string) {
  const auth = await requireUser();
  const tenant = await currentTenantContext();
  if (!tenant) throw new ControlPlaneError("Create your organisation before setting up its context.", 409);
  const canManage = tenant.role === "owner" || tenant.role === "manager";
  return { auth, tenant, canManage, correlationId };
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const { auth, tenant, canManage } = await authenticate(correlationId);
    const [context, routing] = await Promise.all([
      loadBusinessContext(auth.supabase),
      loadConnectorRouting(auth.supabase).catch(() => undefined),
    ]);
    const activeConnectors = routing?.activeConnectors ?? [];
    return json({
      context,
      canManage,
      role: tenant.role,
      activeConnectors,
      refreshDue: businessContextRefreshDue({
        generatedAt: context?.generatedAt ?? null,
        connectors: context?.connectors ?? [],
        activeConnectors,
      }),
      sections: BUSINESS_CONTEXT_SECTIONS,
    }, 200, correlationId);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "The business context could not be loaded.", status, correlationId);
  }
}

const putSchema = z.object({
  document: z.unknown(),
  ownerLocked: z.array(z.enum(BUSINESS_CONTEXT_SECTIONS)).max(BUSINESS_CONTEXT_SECTIONS.length).default([]),
}).strict();

export async function PUT(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const { auth, canManage } = await authenticate(correlationId);
    if (!canManage) return jsonError("Only owners and managers can edit the business context.", 403, correlationId);
    const parsed = putSchema.parse(await readBoundedJsonBody(request));
    const document = businessContextDocumentSchema.parse(parsed.document);
    const stored = await saveBusinessContext({ document, source: "owner", ownerLocked: parsed.ownerLocked }, auth.supabase);
    return json({ context: stored }, 200, correlationId);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("The document did not match the business context schema.", 400, correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "The business context could not be saved.", status, correlationId);
  }
}

const postSchema = z.object({
  action: z.enum(["confirm", "regenerate"]),
  preferences: z.unknown().optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const { auth, tenant, canManage } = await authenticate(correlationId);
    if (!canManage) return jsonError("Only owners and managers can change the business context.", 403, correlationId);
    const parsed = postSchema.parse(await readBoundedJsonBody(request));

    if (parsed.action === "confirm") {
      const stored = await confirmBusinessContext(auth.supabase);
      return json({ context: stored }, 200, correlationId);
    }

    // regenerate: a short turn of its own so the governed Cube client has a lease.
    const cubeApiUrl = process.env.CUBE_API_URL;
    const cubeApiSecret = process.env.CUBEJS_API_SECRET;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!cubeApiUrl || !cubeApiSecret || !openaiApiKey) return jsonError("The analytics backend is not configured.", 503, correlationId);
    const preferences = normalizeAgentPreferences(parsed.preferences);
    const [existing, routing, findings] = await Promise.all([
      loadBusinessContext(auth.supabase),
      loadConnectorRouting(auth.supabase),
      loadSourceFindings(auth.supabase).catch(() => []),
    ]);
    const turnId = ulid();
    const begun = await beginConversationTurn({
      turnId,
      message: "Refresh Albert's business context from the connected data.",
      runtimeProfile: {
        provider: providerForModel(preferences.model), runtime: ALBERT_V3_RUNTIME, model: preferences.model,
        reasoningEffort: preferences.reasoningEffort, fastMode: preferences.fastMode, analyticalRuntime: "cube-v3", kind: "business_context_refresh",
      },
      supabase: auth.supabase,
    });
    const conversationId = begun.conversationId;
    void assignConversationTitle({ conversationId, title: "Business context refresh", supabase: auth.supabase }).catch(() => undefined);
    let sequence = 0;
    const started = new Date().toISOString();
    const say = async (text: string, state: "Verified" | "Unavailable") => {
      sequence += 1;
      await appendConversationEvent({
        conversationId, turnId, supabase: auth.supabase,
        event: {
          id: ulid(), sequence, occurredAt: new Date().toISOString(),
          type: "answer", status: state === "Verified" ? "complete" : "warning", state, text,
          provenance: emptyTurnProvenance(tenant.timezone), followUps: [], presentedResultIds: [], claims: [],
        } as never,
      }).catch(() => undefined);
    };
    try {
      const { result } = await runStandaloneBusinessContextRefresh({
        tenantId: tenant.tenant_id,
        conversationId,
        turnId,
        cubeApiUrl,
        cubeApiSecret,
        openaiApiKey,
        openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
        preferences,
        connectorKeys: routing.activeConnectors,
        freshness: routing.freshness,
        existing: existing ? { document: existing.document, ownerLocked: existing.ownerLocked } : undefined,
        sourceFindings: findings,
      });
      const stored = await saveBusinessContext({
        document: result.document,
        rendered: result.rendered,
        source: "generated",
        facts: result.facts,
        generatorVersion: result.generatorVersion,
        model: result.model,
        dataThrough: result.dataThrough,
        connectors: result.connectors,
      }, auth.supabase);
      await say(`Business context refreshed from the connected data (${result.words} words, ${result.facts.probes.filter((p) => p.ok).length}/${result.facts.probes.length} checks). Review it under About your business.`, "Verified");
      await failConversationTurn({ conversationId, turnId, failureCode: "albert_v3_answered", supabase: auth.supabase });
      logger.info("business_context.regenerated", { tenantId: tenant.tenant_id, conversationId, turnId, words: result.words, durationMs: result.durationMs, started }, correlationId);
      return json({ context: stored, conversationId }, 200, correlationId);
    } catch (error) {
      await say("The business context could not be refreshed this time. Try again in a minute.", "Unavailable");
      await failConversationTurn({ conversationId, turnId, failureCode: "albert_business_context_failed", supabase: auth.supabase }).catch(() => undefined);
      logger.error("business_context.regenerate_failed", { tenantId: tenant.tenant_id, conversationId, turnId, ...safeErrorEvidence(error) }, correlationId);
      throw error;
    }
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid request.", 400, correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "The business context could not be updated.", status, correlationId);
  }
}
