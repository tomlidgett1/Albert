import OpenAI from "openai";
import { z } from "zod";
import {
  extractJsonObject,
  inventFallbackPlan,
  parseInventedPlanOrNull,
  suiteVerdict,
  TEST_CHART_PLANNER_INSTRUCTIONS,
  type FlintPlan,
  type TestChartAppearance,
  type TestChartSource,
} from "@/app/dash/lib/test-chart";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";

export const maxDuration = 60;

const requestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  appearance: z.enum(["light", "dark"]).default("light"),
}).strict();

const logger = createServiceLogger("albert-test-chart");

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
});

function jsonError(message: string, status: number, correlationId: string) {
  return Response.json({ error: message }, {
    status,
    headers: { ...responseHeaders, "x-request-id": correlationId },
  });
}

async function inventPlanWithLunaMaxFast(
  question: string,
  signal: AbortSignal,
): Promise<FlintPlan | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  if (!apiKey || !baseUrl) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: 45_000,
    maxRetries: 0,
  });
  const response = await client.responses.create({
    model: "gpt-5.6-luna",
    store: false,
    max_output_tokens: 2_500,
    reasoning: { effort: "max" },
    service_tier: "fast",
    input: [
      { role: "developer", content: TEST_CHART_PLANNER_INSTRUCTIONS },
      { role: "user", content: question },
    ],
  }, { signal });
  const raw = typeof response.output_text === "string" ? response.output_text : "";
  if (!raw.trim()) return null;
  return parseInventedPlanOrNull(extractJsonObject(raw));
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 403;
    return jsonError(error instanceof Error ? error.message : "Request rejected.", status, correlationId);
  }

  try {
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before generating a test chart.", 409, correlationId);
    const rateLimit = await consumeAlbertRateLimit("test-chart.generate");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
  } catch (error) {
    if (error instanceof ControlPlaneError) return jsonError(error.message, error.status, correlationId);
    return jsonError("Authentication could not be completed.", 503, correlationId);
  }

  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await readBoundedJsonBody(request, 2_048));
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 400;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "A valid question is required.",
      status,
      correlationId,
    );
  }

  const question = parsed.question;
  const appearance: TestChartAppearance = parsed.appearance;
  let plan = inventFallbackPlan(question);
  let source: TestChartSource = "fallback";
  try {
    const invented = await inventPlanWithLunaMaxFast(question, request.signal);
    if (invented) {
      plan = invented;
      source = "luna";
    }
  } catch (error) {
    logger.warn("test_chart.planner_fallback", safeErrorEvidence(error), correlationId);
  }

  const scored = suiteVerdict(plan.chart_spec.chartType, question);
  return Response.json({
    question,
    invented: true,
    source,
    chartType: plan.chart_spec.chartType,
    title: plan.chart_spec.title,
    subtitle: plan.chart_spec.subtitle,
    rationale: plan.rationale,
    appearance,
    warnings: [],
    ...scored,
    flint: {
      semantic_types: plan.semantic_types,
      ...(plan.field_display_names ? { field_display_names: plan.field_display_names } : {}),
      chart_spec: plan.chart_spec,
    },
    data: plan.data,
  }, { headers: { ...responseHeaders, "x-request-id": correlationId } });
}
