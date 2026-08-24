/**
 * Homepage recommended analysis (ADR 0117).
 *
 * GET  → cached Luna brief when the corpus fingerprint matches, otherwise
 *        the deterministic playbook so the homepage paints immediately.
 * POST → refine with Luna (fast, medium effort), persist, return.
 */
import { createHash } from "node:crypto";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  loadConnectorRouting,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { loadBusinessContext } from "@/services/control-plane/src/business-context-repository";
import {
  briefsFingerprint,
  loadProactiveSignal,
  loadRecommendedAnalysisCache,
  loadRecommendedAnalysisCorpus,
  saveRecommendedAnalysisCache,
} from "@/services/control-plane/src/recommended-analysis-repository";
import { loadSemanticMemory } from "@/services/control-plane/src/semantic-memory-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";
import { buildAnalysisCorpus } from "@/services/recommended-analysis/src/corpus";
import { composePlaybookBrief, RECOMMENDED_ANALYSIS_MODEL, synthesizeRecommendedAnalysis } from "@/services/recommended-analysis/src/synthesize";

export const maxDuration = 60;

const logger = createServiceLogger("albert-recommended-analysis-web");

type Source = "cache" | "playbook" | "model" | "empty";

function json(body: unknown, correlationId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, correlationId, status);
}

async function loadContext() {
  const auth = await requireUser();
  const tenant = await currentTenantContext();
  if (!tenant) throw new ControlPlaneError("Create your organisation before using Albert.", 409);
  const [corpusRows, cache, routing, context, proactive, memory] = await Promise.all([
    loadRecommendedAnalysisCorpus(auth.supabase),
    loadRecommendedAnalysisCache(auth.supabase).catch(() => null),
    loadConnectorRouting(auth.supabase).catch(() => undefined),
    loadBusinessContext(auth.supabase).catch(() => null),
    loadProactiveSignal(auth.supabase).catch(() => null),
    loadSemanticMemory(auth.supabase).catch(() => []),
  ]);
  const corpus = buildAnalysisCorpus({
    briefs: corpusRows.briefs,
    coverage: corpusRows.coverage,
    proactive,
    connectors: routing?.activeConnectors ?? [],
    vocabulary: memory
      .filter((rule) => rule.status === "confirmed" || rule.status === "proposed")
      .slice(0, 16)
      .map((rule) => ({ term: rule.term, meaning: rule.meaning })),
  });
  const fingerprint = corpus.briefs.length > 0 || corpus.proactive
    ? briefsFingerprint(corpus)
    : "";
  return {
    auth,
    tenant,
    corpus,
    cache,
    fingerprint,
    businessContext: context?.rendered ?? `A small business named ${tenant.tenant_name}.`,
  };
}

function emptyPayload(source: Source = "empty") {
  return {
    verdict: "",
    recommendations: [],
    sourceCount: 0,
    source,
    fingerprint: "",
  };
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const loaded = await loadContext();
    if (loaded.corpus.briefs.length === 0 && !loaded.corpus.proactive) {
      return json(emptyPayload(), correlationId);
    }
    if (loaded.cache && loaded.cache.sourceFingerprint === loaded.fingerprint && loaded.cache.recommendations.length > 0) {
      return json({
        verdict: loaded.cache.verdict,
        recommendations: loaded.cache.recommendations,
        sourceCount: loaded.cache.sourceCount,
        source: "cache" satisfies Source,
        fingerprint: loaded.fingerprint,
        generatedAt: loaded.cache.generatedAt,
      }, correlationId);
    }
    const playbook = composePlaybookBrief(loaded.corpus);
    return json({
      verdict: playbook.verdict,
      recommendations: playbook.recommendations,
      sourceCount: loaded.corpus.briefs.length,
      source: "playbook" satisfies Source,
      fingerprint: loaded.fingerprint,
    }, correlationId);
  } catch (error) {
    logger.error("recommended_analysis.get_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof Error ? error.message : "Recommended analysis could not be loaded.",
      status,
      correlationId,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const loaded = await loadContext();
    if (loaded.corpus.briefs.length === 0 && !loaded.corpus.proactive) {
      return json(emptyPayload(), correlationId);
    }
    if (loaded.cache && loaded.cache.sourceFingerprint === loaded.fingerprint && loaded.cache.recommendations.length > 0) {
      return json({
        verdict: loaded.cache.verdict,
        recommendations: loaded.cache.recommendations,
        sourceCount: loaded.cache.sourceCount,
        source: "cache" satisfies Source,
        fingerprint: loaded.fingerprint,
        generatedAt: loaded.cache.generatedAt,
      }, correlationId);
    }

    const decision = await consumeAlbertRateLimit("conversation.recommended_analysis");
    if (!decision.allowed) return rateLimitExceededResponse(decision);

    const playbook = composePlaybookBrief(loaded.corpus);
    let verdict = playbook.verdict;
    let recommendations = playbook.recommendations;
    let source: Source = "playbook";
    let model = "playbook";
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (apiKey && playbook.recommendations.length > 0) {
      const refined = await synthesizeRecommendedAnalysis({
        corpus: loaded.corpus,
        playbook: playbook.recommendations,
        playbookVerdict: playbook.verdict,
        businessContext: loaded.businessContext,
        apiKey,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        safetyIdentifier: createHash("sha256")
          .update(`${loaded.tenant.tenant_id}:${loaded.auth.user.id}`)
          .digest("hex"),
        signal: request.signal,
      });
      if (refined && refined.recommendations.length >= 3) {
        verdict = refined.verdict;
        recommendations = refined.recommendations;
        source = "model";
        model = RECOMMENDED_ANALYSIS_MODEL;
      }
    }

    if (recommendations.length > 0) {
      const stored = await saveRecommendedAnalysisCache({
        sourceFingerprint: loaded.fingerprint,
        sourceCount: loaded.corpus.briefs.length,
        verdict,
        recommendations,
        model,
      }, loaded.auth.supabase);
      return json({
        verdict: stored.verdict,
        recommendations: stored.recommendations,
        sourceCount: stored.sourceCount,
        source,
        fingerprint: stored.sourceFingerprint,
        generatedAt: stored.generatedAt,
      }, correlationId);
    }

    return json({
      verdict,
      recommendations: [],
      sourceCount: loaded.corpus.briefs.length,
      source: "playbook" satisfies Source,
      fingerprint: loaded.fingerprint,
    }, correlationId);
  } catch (error) {
    logger.error("recommended_analysis.post_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof Error ? error.message : "Recommended analysis could not be written.",
      status,
      correlationId,
    );
  }
}
