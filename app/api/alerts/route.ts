/**
 * Heads-up alerts API (ADR 0132) — the Alerts tab's whole surface.
 *
 *   GET  → { triggers, events, settings, lastEvaluation, openEvaluation, numbers, defaults, botNumberDisplay, canManage }
 *   POST → { action: "update", triggerKey, enabled?, recipients? }
 *        | { action: "check" }
 *
 * The catalogue (what each trigger watches) lives in code; the control plane
 * stores each tenant's switches, recipients, readings and fired events. A
 * trigger without a stored row is on and goes to the owner's enrolled
 * number. "check" queues an evaluation that the imessage-bridge runs within
 * its poll interval; the tab polls GET while a check is open.
 */
import { ulid } from "ulid";
import { z } from "zod";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import {
  ALERT_TRIGGER_CATALOGUE,
  ALERT_TRIGGER_KEYS,
  PHONE_E164_PATTERN,
  type AlertEvent,
  type AlertTriggerRow,
  type AlertTriggerState,
} from "@/services/alerts/src/contracts";
import {
  loadAlertsWorkspace,
  requestAlertsCheck,
  saveAlertTrigger,
} from "@/services/control-plane/src/alerts-repository";
import { loadImessageWorkspace } from "@/services/control-plane/src/imessage-repository";
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
import { ALBERT_IMESSAGE_BOT_NUMBER_DISPLAY } from "@/services/imessage-bridge/src/contracts";

export const maxDuration = 30;

const logger = createServiceLogger("albert-alerts-web");

function json(body: unknown, status: number, correlationId: string): Response {
  return Response.json(body, { status, headers: { "x-request-id": correlationId, "Cache-Control": "no-store" } });
}

function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, status, correlationId);
}

async function authenticate() {
  const auth = await requireUser();
  const tenant = await currentTenantContext();
  if (!tenant) throw new ControlPlaneError("Create your organisation before setting up alerts.", 409);
  return { auth, tenant, canManage: tenant.role === "owner" || tenant.role === "manager" };
}

type Numbers = ReadonlyArray<Readonly<{ phone: string; displayName: string | null; isOwner: boolean }>>;

async function enrolledNumbers(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"]): Promise<Numbers> {
  const workspace = await loadImessageWorkspace(supabase).catch(() => null);
  return Object.freeze((workspace?.enrollments ?? [])
    .filter((enrollment) => enrollment.enabled)
    .map((enrollment) => Object.freeze({
      phone: enrollment.phone,
      displayName: enrollment.displayName,
      isOwner: enrollment.isOwner,
    })));
}

/** The catalogue merged with the tenant's rows, readings and latest events, in catalogue order. */
function mergeTriggers(input: Readonly<{
  rows: readonly AlertTriggerRow[];
  states: readonly AlertTriggerState[];
  events: readonly AlertEvent[];
  defaultRecipients: readonly string[];
  enabledPhones: ReadonlySet<string>;
}>) {
  const rows = new Map(input.rows.map((row) => [row.triggerKey, row]));
  const states = new Map(input.states.map((state) => [state.triggerKey, state]));
  return ALERT_TRIGGER_CATALOGUE.map((definition) => {
    const row = rows.get(definition.key);
    const recipients = row
      ? row.recipients.filter((phone) => input.enabledPhones.has(phone))
      : input.defaultRecipients;
    const state = states.get(definition.key) ?? null;
    return {
      ...definition,
      needs: [...definition.needs],
      enabled: row?.enabled ?? true,
      recipients: [...recipients],
      stored: Boolean(row),
      updatedAt: row?.updatedAt ?? null,
      state: state
        ? { lastEvaluatedAt: state.lastEvaluatedAt, lastResult: state.lastResult, lastFiredAt: state.lastFiredAt }
        : null,
      recentEvents: input.events.filter((event) => event.triggerKey === definition.key).slice(0, 3).map(serialiseEvent),
    };
  });
}

function serialiseEvent(event: AlertEvent) {
  return { ...event, recipients: [...event.recipients], evidence: { ...event.evidence } };
}

async function payload(auth: Awaited<ReturnType<typeof authenticate>>) {
  const [workspace, numbers] = await Promise.all([
    loadAlertsWorkspace(auth.auth.supabase),
    enrolledNumbers(auth.auth.supabase),
  ]);
  const owner = numbers.find((number) => number.isOwner) ?? numbers[0] ?? null;
  const defaultRecipients = owner ? [owner.phone] : [];
  return {
    triggers: mergeTriggers({
      rows: workspace.triggers,
      states: workspace.states,
      events: workspace.events,
      defaultRecipients,
      enabledPhones: new Set(numbers.map((number) => number.phone)),
    }),
    events: workspace.events.map(serialiseEvent),
    settings: workspace.settings,
    lastEvaluation: workspace.lastEvaluation,
    openEvaluation: workspace.openEvaluation,
    numbers,
    defaults: { recipients: defaultRecipients },
    botNumberDisplay: ALBERT_IMESSAGE_BOT_NUMBER_DISPLAY,
    canManage: auth.canManage,
  };
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const auth = await authenticate();
    return json(await payload(auth), 200, correlationId);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("alerts.get_failed", safeErrorEvidence(error), correlationId);
    return jsonError(error instanceof Error ? error.message : "Alerts could not be loaded.", status, correlationId);
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    triggerKey: z.enum(ALERT_TRIGGER_KEYS),
    enabled: z.boolean().optional(),
    recipients: z.array(z.string().regex(PHONE_E164_PATTERN)).max(20).optional(),
  }).strict(),
  z.object({
    action: z.literal("check"),
  }).strict(),
]);

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const auth = await authenticate();
    const body = postSchema.parse(await readBoundedJsonBody(request));
    if (!auth.canManage) return jsonError("Only owners and managers can manage alerts.", 403, correlationId);

    if (body.action === "check") {
      const decision = await consumeAlbertRateLimit("alerts.check");
      if (!decision.allowed) return rateLimitExceededResponse(decision);
      const evaluation = await requestAlertsCheck({ evaluationId: ulid() }, auth.auth.supabase);
      logger.info("alerts.check_requested", { tenantId: auth.tenant.tenant_id, evaluationId: evaluation.evaluationId }, correlationId);
      return json({ evaluation }, 200, correlationId);
    }

    const decision = await consumeAlbertRateLimit("alerts.mutation");
    if (!decision.allowed) return rateLimitExceededResponse(decision);
    // Merge the patch over the stored row (or the catalogue default) so a
    // switch flip never drops the recipients and vice versa.
    const current = await payload(auth);
    const existing = current.triggers.find((trigger) => trigger.key === body.triggerKey);
    if (!existing) return jsonError("Unknown alert.", 404, correlationId);
    const row = await saveAlertTrigger({
      triggerKey: body.triggerKey,
      enabled: body.enabled ?? existing.enabled,
      recipients: body.recipients ?? existing.recipients,
    }, auth.auth.supabase);
    return json({
      trigger: {
        ...existing,
        enabled: row.enabled,
        recipients: [...row.recipients],
        stored: true,
        updatedAt: row.updatedAt,
      },
    }, 200, correlationId);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("That request wasn't valid.", 400, correlationId);
    }
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("alerts.mutation_failed", safeErrorEvidence(error), correlationId);
    return jsonError(error instanceof Error ? error.message : "The change could not be saved.", status, correlationId);
  }
}
