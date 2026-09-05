/**
 * iMessage enrolment API — the /imessage page's whole surface.
 *
 *   GET  → { botNumber, botNumberDisplay, workspace, canManage }
 *   POST → { action: "enroll", phone, displayName? }
 *        | { action: "remove", enrollmentId }
 *        | { action: "setEnabled", enrollmentId, enabled }
 *        | { action: "setGroupChats", allowed }
 *
 * Enrolling a new number also sends it a short intro text through Linq (so
 * the person knows which number to talk to); the enrolment stands even when
 * that send fails.
 */
import { z } from "zod";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import { ControlPlaneError, currentTenantContext, requireUser } from "@/services/control-plane/src/web-repository";
import {
  enrollImessageNumber,
  loadImessageWorkspace,
  removeImessageEnrollment,
  setImessageGroupChats,
  updateImessageEnrollment,
} from "@/services/control-plane/src/imessage-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";
import {
  ALBERT_IMESSAGE_BOT_NUMBER,
  ALBERT_IMESSAGE_BOT_NUMBER_DISPLAY,
  imessageIntroText,
} from "@/services/imessage-bridge/src/contracts";
import { LinqClient } from "@/services/imessage-bridge/src/linq";

const logger = createServiceLogger("albert-imessage-web");

function json(body: unknown, status: number, correlationId: string): Response {
  return Response.json(body, { status, headers: { "x-request-id": correlationId, "Cache-Control": "no-store" } });
}
function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, status, correlationId);
}

async function authenticate() {
  const auth = await requireUser();
  const tenant = await currentTenantContext();
  if (!tenant) throw new ControlPlaneError("Create your organisation before setting up iMessage.", 409);
  return { auth, tenant, canManage: tenant.role === "owner" || tenant.role === "manager" };
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const { auth, canManage } = await authenticate();
    const workspace = await loadImessageWorkspace(auth.supabase);
    return json({
      botNumber: ALBERT_IMESSAGE_BOT_NUMBER,
      botNumberDisplay: ALBERT_IMESSAGE_BOT_NUMBER_DISPLAY,
      workspace,
      canManage,
    }, 200, correlationId);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(error instanceof Error ? error.message : "iMessage setup could not be loaded.", status, correlationId);
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enroll"),
    phone: z.string().trim().min(6).max(24),
    displayName: z.string().trim().min(1).max(80).optional(),
  }).strict(),
  z.object({
    action: z.literal("remove"),
    enrollmentId: z.string().trim().min(8).max(60),
  }).strict(),
  z.object({
    action: z.literal("setEnabled"),
    enrollmentId: z.string().trim().min(8).max(60),
    enabled: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal("setGroupChats"),
    allowed: z.boolean(),
  }).strict(),
]);

async function sendIntroText(input: Readonly<{
  phone: string;
  displayName?: string;
  organisationName: string;
  correlationId: string;
}>): Promise<boolean> {
  const token = process.env.LINQ_API_TOKEN?.trim();
  if (!token) return false;
  try {
    const linq = new LinqClient(
      process.env.LINQ_API_BASE_URL?.trim() || "https://api.linqapp.com/api/partner/v3",
      token,
    );
    await linq.createChat(ALBERT_IMESSAGE_BOT_NUMBER, input.phone, imessageIntroText({
      organisationName: input.organisationName,
      displayName: input.displayName ?? null,
    }));
    return true;
  } catch (error) {
    logger.warn("imessage.intro_text_failed", { phone: input.phone, ...safeErrorEvidence(error) }, input.correlationId);
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const { auth, tenant } = await authenticate();
    const body = postSchema.parse(await readBoundedJsonBody(request));
    if (body.action === "enroll") {
      const result = await enrollImessageNumber({
        phone: body.phone,
        ...(body.displayName ? { displayName: body.displayName } : {}),
      }, auth.supabase);
      const introSent = result.existed ? false : await sendIntroText({
        phone: result.enrollment.phone,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        organisationName: tenant.tenant_name,
        correlationId,
      });
      return json({ enrollment: result.enrollment, existed: result.existed, introSent }, 200, correlationId);
    }
    if (body.action === "remove") {
      const removed = await removeImessageEnrollment(body.enrollmentId, auth.supabase);
      return json({ removed }, 200, correlationId);
    }
    if (body.action === "setEnabled") {
      const enrollment = await updateImessageEnrollment({
        enrollmentId: body.enrollmentId,
        enabled: body.enabled,
      }, auth.supabase);
      return json({ enrollment }, 200, correlationId);
    }
    const allowed = await setImessageGroupChats(body.allowed, auth.supabase);
    return json({ allowGroupChats: allowed }, 200, correlationId);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("That request wasn't valid.", 400, correlationId);
    }
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("imessage.mutation_failed", safeErrorEvidence(error), correlationId);
    return jsonError(error instanceof Error ? error.message : "The change could not be saved.", status, correlationId);
  }
}
