/**
 * Semantic memory API — the deterministic vocabulary rules Albert has learned
 * for this tenant (ADR 0115), surfaced in Settings as "Albert's memory".
 *
 *   GET  → every rule (retired included), whether the caller can hard-delete.
 *   PUT  → manual rule: { term, meaning, counterMeaning? } → saved confirmed.
 *   POST → { action: "confirm" | "retire" | "restore" | "delete", ruleId }.
 */
import { z } from "zod";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import { ControlPlaneError, currentTenantContext, requireUser } from "@/services/control-plane/src/web-repository";
import {
  deleteSemanticRule,
  loadSemanticMemory,
  saveSemanticRule,
  updateSemanticRuleStatus,
} from "@/services/control-plane/src/semantic-memory-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";

const logger = createServiceLogger("albert-semantic-memory-web");

function json(body: unknown, status: number, correlationId: string): Response {
  return Response.json(body, { status, headers: { "x-request-id": correlationId, "Cache-Control": "no-store" } });
}
function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, status, correlationId);
}

async function authenticate() {
  const auth = await requireUser();
  const tenant = await currentTenantContext();
  if (!tenant) throw new ControlPlaneError("Create your organisation before reviewing Albert's memory.", 409);
  return { auth, tenant, canDelete: tenant.role === "owner" || tenant.role === "manager" };
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const { auth, canDelete } = await authenticate();
    const rules = await loadSemanticMemory(auth.supabase);
    return json({ rules, canDelete }, 200, correlationId);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "Albert's learned rules could not be loaded.", status, correlationId);
  }
}

const putSchema = z.object({
  term: z.string().trim().min(2).max(80),
  meaning: z.string().trim().min(3).max(300),
  counterMeaning: z.string().trim().min(3).max(300).optional(),
}).strict();

export async function PUT(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const { auth, tenant } = await authenticate();
    const parsed = putSchema.parse(await readBoundedJsonBody(request));
    const rule = await saveSemanticRule({
      kind: "term_binding",
      term: parsed.term,
      meaning: parsed.meaning,
      counterMeaning: parsed.counterMeaning ?? null,
      status: "confirmed",
      source: "owner",
    }, auth.supabase);
    logger.info("semantic_memory.rule_created", { tenantId: tenant.tenant_id, ruleId: rule.ruleId }, correlationId);
    return json({ rule }, 200, correlationId);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("A rule needs a term (2–80 characters) and a meaning (3–300 characters).", 400, correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "The rule could not be saved.", status, correlationId);
  }
}

const postSchema = z.object({
  action: z.enum(["confirm", "retire", "restore", "delete"]),
  ruleId: z.string().min(8).max(60),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const { auth, tenant, canDelete } = await authenticate();
    const parsed = postSchema.parse(await readBoundedJsonBody(request));
    if (parsed.action === "delete") {
      if (!canDelete) return jsonError("Only owners and managers can delete learned rules; retiring is available to everyone.", 403, correlationId);
      await deleteSemanticRule(parsed.ruleId, auth.supabase);
      logger.info("semantic_memory.rule_deleted", { tenantId: tenant.tenant_id, ruleId: parsed.ruleId }, correlationId);
      return json({ deleted: true }, 200, correlationId);
    }
    const status = parsed.action === "confirm" ? "confirmed" : parsed.action === "retire" ? "retired" : "confirmed";
    const rule = await updateSemanticRuleStatus(parsed.ruleId, status, auth.supabase);
    logger.info("semantic_memory.rule_status_changed", {
      tenantId: tenant.tenant_id,
      ruleId: rule.ruleId,
      status: rule.status,
    }, correlationId);
    return json({ rule }, 200, correlationId);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid request.", 400, correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.warn("semantic_memory.mutation_failed", safeErrorEvidence(error), correlationId);
    return jsonError(error instanceof Error ? error.message : "The rule could not be updated.", status, correlationId);
  }
}
