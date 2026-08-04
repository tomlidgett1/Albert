import { z } from "zod";
import registrySource from "@/packages/semantic-registry/registry/registry.yaml?raw";
import { normalizeAgentPreferences } from "@/packages/shared/src";
import {
  isInternalOperator,
} from "@/services/control-plane/src/operator-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { runPlanPreviewTurn } from "@/services/conversation/src/plan-preview";

const requestSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  preferences: z.unknown().optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    await requireUser();
    if (!(await isInternalOperator())) {
      return Response.json({ error: "Internal operator access is required." }, { status: 403 });
    }

    const tenant = await currentTenantContext();
    if (!tenant) {
      return Response.json({ error: "An active organisation is required for plan preview." }, { status: 400 });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
    const openaiBaseUrl = process.env.OPENAI_BASE_URL?.trim();
    if (!openaiApiKey || !openaiBaseUrl) {
      return Response.json({ error: "OpenAI is not configured for plan preview." }, { status: 503 });
    }

    const body = requestSchema.parse(await readBoundedJsonBody(request, 12_000));
    const preview = await runPlanPreviewTurn({
      question: body.question,
      tenantId: tenant.tenant_id,
      role: tenant.role,
      registrySource,
      preferences: normalizeAgentPreferences(body.preferences),
      openaiApiKey,
      openaiBaseUrl,
      semanticServiceUrl: process.env.SEMANTIC_QUERY_SERVICE_URL?.trim() || undefined,
      semanticSigningSecret: process.env.ALBERT_SEMANTIC_SIGNING_SECRET?.trim() || undefined,
      openaiTracingEnabled: process.env.ALBERT_OPENAI_TRACING_ENABLED === "true",
    });

    return Response.json({ preview }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid question is required." }, { status: 400 });
    }
    return Response.json({
      error: error instanceof Error ? error.message : "Plan preview is unavailable.",
    }, { status: 503 });
  }
}
