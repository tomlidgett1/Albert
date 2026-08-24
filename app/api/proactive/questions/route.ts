/**
 * Generate (or refresh) the Proactive question bank (ADR 0113, iteration 3).
 * POST {} — Luna at max effort on the fast tier writes ~40 owner-voice
 * questions from the business context and the latest research headlines,
 * persisted per tenant. Owner/manager only.
 */
import { createHash } from "node:crypto";
import { buildQuestionBank, QUESTION_BANK_MODEL } from "@/services/proactive/src/question-bank";
import {
  loadProactivePanel,
  recordProactiveQuestionBank,
} from "@/services/control-plane/src/proactive-repository";
import { loadBusinessContext } from "@/services/control-plane/src/business-context-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  loadConnectorRouting,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation } from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

export const maxDuration = 180;

const logger = createServiceLogger("albert-proactive-web");

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
    if (!tenant) return jsonError("Create your organisation before using Proactive.", 409, correlationId);
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return jsonError("Only owners and managers can refresh the questions.", 403, correlationId);
    }
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return jsonError("Questions are not configured on this environment.", 503, correlationId);

    const [panel, context, routing] = await Promise.all([
      loadProactivePanel().catch(() => null),
      loadBusinessContext(auth.supabase).catch(() => null),
      loadConnectorRouting(auth.supabase).catch(() => undefined),
    ]);
    const findingHeadlines = (panel?.run?.findings ?? [])
      .filter((finding) => finding.status === "completed" && finding.headline)
      .map((finding) => `${finding.agentTitle}: ${finding.headline}`);
    const bank = await buildQuestionBank({
      businessContext: context?.rendered ?? `A small business named ${tenant.tenant_name ?? "the business"}.`,
      findingHeadlines,
      activeConnectors: routing?.activeConnectors ?? [],
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      safetyIdentifier: createHash("sha256")
        .update(`${tenant.tenant_id}:${auth.user.id}`)
        .digest("hex"),
      signal: request.signal,
    });
    if (!bank) return jsonError("The questions could not be written this time.", 503, correlationId);
    const stored = await recordProactiveQuestionBank({
      questions: bank.questions,
      model: QUESTION_BANK_MODEL,
    });
    logger.info("proactive.question_bank_recorded", {
      tenantId: tenant.tenant_id,
      questions: stored.questions.length,
    }, correlationId);
    return Response.json({ questionBank: stored }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    logger.error("proactive.question_bank_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The questions could not be refreshed.",
      status,
      correlationId,
    );
  }
}
