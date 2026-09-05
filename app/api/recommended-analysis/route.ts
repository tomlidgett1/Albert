/**
 * Homepage "What to look at next" (ADR 0117, ADR 0133).
 *
 * GET → the daily look when the bridge has written one (once a day, Luna at
 *       max effort on the Omni harness; migration 0164's row, named
 *       `omni:<model>`), otherwise the cached chat-history brief while its
 *       corpus fingerprint still matches, otherwise the deterministic
 *       playbook. Every row names the connected tool it reads. Nothing is
 *       generated on request: the daily loop in the imessage-bridge owns
 *       generation, so a homepage visit never waits on a model.
 */
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import {
  ControlPlaneError,
  currentTenantContext,
  loadConnectorRouting,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  briefsFingerprint,
  loadProactiveSignal,
  loadRecommendedAnalysisCache,
  loadRecommendedAnalysisCorpus,
} from "@/services/control-plane/src/recommended-analysis-repository";
import { loadSemanticMemory } from "@/services/control-plane/src/semantic-memory-repository";
import { buildAnalysisCorpus, buildPlaybookVerdict, type AnalysisCorpus } from "@/services/recommended-analysis/src/corpus";
import { isDailyBriefModel } from "@/services/recommended-analysis/src/daily-brief";
import { buildPlaybookRecommendations, type RecommendedQuestion } from "@/services/recommended-analysis/src/playbook";
import { normaliseRecommendedTools, withRecommendedTools } from "@/services/recommended-analysis/src/tools";

export const maxDuration = 30;

const logger = createServiceLogger("albert-recommended-analysis-web");

type Source = "daily" | "cache" | "playbook" | "empty";

type Payload = Readonly<{
  verdict: string;
  recommendations: readonly RecommendedQuestion[];
  sourceCount: number;
  source: Source;
  /** The connected tools, as public ids, so the panel can explain a missing logo. */
  connectors: readonly string[];
  fingerprint: string;
  generatedAt?: string;
}>;

function json(body: unknown, correlationId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, correlationId, status);
}

/** The instant, deterministic brief: the playbook's verdict and three next questions over the corpus. */
function composePlaybookBrief(corpus: AnalysisCorpus, now = new Date()) {
  const built = buildAnalysisCorpus(corpus);
  return Object.freeze({
    verdict: buildPlaybookVerdict(built, now),
    recommendations: buildPlaybookRecommendations(built.briefs, built.connectors, now, {
      coverage: built.coverage,
      proactive: built.proactive,
    }),
  });
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) throw new ControlPlaneError("Create your organisation before using Albert.", 409);
    const [cache, routing] = await Promise.all([
      loadRecommendedAnalysisCache(auth.supabase).catch(() => null),
      loadConnectorRouting(auth.supabase).catch(() => undefined),
    ]);
    const connectorKeys = routing?.activeConnectors ?? [];
    const connectors = normaliseRecommendedTools(connectorKeys);

    // Once the daily look exists it is the brief: the last 24 hours, refreshed
    // by the bridge once a day, never by a homepage visit.
    if (cache && isDailyBriefModel(cache.model)) {
      return json({
        verdict: cache.verdict,
        recommendations: withRecommendedTools(cache.recommendations, connectorKeys),
        sourceCount: cache.sourceCount,
        source: "daily",
        connectors,
        fingerprint: cache.sourceFingerprint,
        generatedAt: cache.generatedAt,
      } satisfies Payload, correlationId);
    }

    const [corpusRows, proactive, memory] = await Promise.all([
      loadRecommendedAnalysisCorpus(auth.supabase),
      loadProactiveSignal(auth.supabase).catch(() => null),
      loadSemanticMemory(auth.supabase).catch(() => []),
    ]);
    const corpus = buildAnalysisCorpus({
      briefs: corpusRows.briefs,
      coverage: corpusRows.coverage,
      proactive,
      connectors: connectorKeys,
      vocabulary: memory
        .filter((rule) => rule.status === "confirmed" || rule.status === "proposed")
        .slice(0, 16)
        .map((rule) => ({ term: rule.term, meaning: rule.meaning })),
    });
    if (corpus.briefs.length === 0 && !corpus.proactive) {
      return json({
        verdict: "",
        recommendations: [],
        sourceCount: 0,
        source: "empty",
        connectors,
        fingerprint: "",
      } satisfies Payload, correlationId);
    }
    const fingerprint = briefsFingerprint(corpus);
    if (cache && cache.sourceFingerprint === fingerprint && cache.recommendations.length > 0) {
      return json({
        verdict: cache.verdict,
        recommendations: withRecommendedTools(cache.recommendations, connectorKeys),
        sourceCount: cache.sourceCount,
        source: "cache",
        connectors,
        fingerprint,
        generatedAt: cache.generatedAt,
      } satisfies Payload, correlationId);
    }
    const playbook = composePlaybookBrief(corpus);
    return json({
      verdict: playbook.verdict,
      recommendations: withRecommendedTools(playbook.recommendations, connectorKeys),
      sourceCount: corpus.briefs.length,
      source: "playbook",
      connectors,
      fingerprint,
    } satisfies Payload, correlationId);
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
