/**
 * Build and persist the morning-brief synthesis for a completed Proactive run
 * (ADR 0113, iteration 2). POST { runId } — idempotent: an existing synthesis
 * is returned as-is unless force is set. Owner/manager only.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildProactiveSynthesis } from "@/services/proactive/src/synthesis";
import {
  loadProactivePanel,
  recordProactiveSynthesis,
} from "@/services/control-plane/src/proactive-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

export const maxDuration = 120;

const logger = createServiceLogger("albert-proactive-web");

const bodySchema = z.object({
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  force: z.boolean().optional(),
}).strict();

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
      return jsonError("Only owners and managers can build the morning brief.", 403, correlationId);
    }
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return jsonError("The morning brief is not configured on this environment.", 503, correlationId);

    const panel = await loadProactivePanel();
    const run = panel.run;
    if (!run || run.runId !== parsed.runId) {
      return jsonError("That research run is no longer current.", 409, correlationId);
    }
    if (run.synthesis && !parsed.force) {
      return Response.json({ synthesis: run.synthesis }, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }
    const completed = run.findings.filter((finding) => finding.status === "completed");
    if (completed.length < 2) {
      return jsonError("Not enough completed research to build the brief.", 409, correlationId);
    }
    const synthesis = await buildProactiveSynthesis({
      businessName: tenant.tenant_name ?? "the business",
      findings: completed.map((finding) => ({
        agentKey: finding.agentKey,
        agentTitle: finding.agentTitle,
        answerState: finding.answerState,
        headline: finding.headline,
        keyNumbers: finding.keyNumbers,
        summaryExcerpt: finding.summary ?? "",
      })),
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      safetyIdentifier: createHash("sha256")
        .update(`${tenant.tenant_id}:${auth.user.id}`)
        .digest("hex"),
      signal: request.signal,
    });
    if (!synthesis) return jsonError("The morning brief could not be written this time.", 503, correlationId);
    const stored = await recordProactiveSynthesis({ runId: run.runId, synthesis });
    logger.info("proactive.synthesis_recorded", {
      tenantId: tenant.tenant_id,
      runId: run.runId,
      highlights: synthesis.highlights.length,
    }, correlationId);
    return Response.json({ synthesis: stored.synthesis ?? synthesis }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid synthesis request.", 400, correlationId);
    logger.error("proactive.synthesis_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The morning brief could not be written.",
      status,
      correlationId,
    );
  }
}
