/**
 * Scheduled reports API (ADR 0131) — the Scheduled tab's whole surface.
 *
 *   GET  → { tasks, numbers, defaults: { timezone, phone }, botNumberDisplay, canManage }
 *   POST → { action: "create", text, timezone? }
 *        | { action: "update", taskId, title?, prompt?, timeOfDay?, days?, timezone?, phone?, enabled? }
 *        | { action: "delete", taskId }
 *        | { action: "run", taskId }
 *
 * "create" reads the owner's description with Luna (the deterministic
 * reading is the floor when the model is unavailable), computes the first
 * run and saves the schedule. "run" queues a manual run that the
 * imessage-bridge scheduler executes within its poll interval; the tab polls
 * GET while a run is open.
 */
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import { loadImessageWorkspace } from "@/services/control-plane/src/imessage-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import {
  deleteScheduledTask,
  loadScheduledWorkspace,
  requestScheduledRun,
  saveScheduledTask,
} from "@/services/control-plane/src/scheduled-repository";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { ALBERT_IMESSAGE_BOT_NUMBER_DISPLAY } from "@/services/imessage-bridge/src/contracts";
import {
  isValidTimezone,
  normaliseScheduleDays,
  PHONE_E164_PATTERN,
  SCHEDULE_DAYS,
  TIME_OF_DAY_PATTERN,
  type ScheduledTask,
} from "@/services/scheduled/src/contracts";
import { nextScheduledRunAt } from "@/services/scheduled/src/next-run";
import { parseScheduleRequest, SCHEDULE_PROMPT_MAX, SCHEDULE_TITLE_MAX } from "@/services/scheduled/src/parse";

export const maxDuration = 60;

const logger = createServiceLogger("albert-scheduled-web");

function json(body: unknown, status: number, correlationId: string): Response {
  return Response.json(body, { status, headers: { "x-request-id": correlationId, "Cache-Control": "no-store" } });
}

function jsonError(message: string, status: number, correlationId: string): Response {
  return json({ error: message }, status, correlationId);
}

async function authenticate() {
  const auth = await requireUser();
  const tenant = await currentTenantContext();
  if (!tenant) throw new ControlPlaneError("Create your organisation before scheduling reports.", 409);
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

function serialiseTask(task: ScheduledTask) {
  return {
    ...task,
    days: [...task.days],
    recentRuns: [...task.recentRuns],
  };
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const { auth, tenant, canManage } = await authenticate();
    const [tasks, numbers] = await Promise.all([
      loadScheduledWorkspace(auth.supabase),
      enrolledNumbers(auth.supabase),
    ]);
    const owner = numbers.find((number) => number.isOwner) ?? numbers[0] ?? null;
    return json({
      tasks: tasks.map(serialiseTask),
      numbers,
      defaults: { timezone: tenant.timezone, phone: owner?.phone ?? null },
      botNumberDisplay: ALBERT_IMESSAGE_BOT_NUMBER_DISPLAY,
      canManage,
    }, 200, correlationId);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("scheduled.get_failed", safeErrorEvidence(error), correlationId);
    return jsonError(error instanceof Error ? error.message : "Schedules could not be loaded.", status, correlationId);
  }
}

const taskIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const timezoneSchema = z.string().trim().min(1).max(80).refine(isValidTimezone, "Unknown time zone.");

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    text: z.string().trim().min(3).max(2_000),
    /** The browser's zone, used as the default when the owner names none. */
    timezone: timezoneSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal("update"),
    taskId: taskIdSchema,
    title: z.string().trim().min(1).max(SCHEDULE_TITLE_MAX).optional(),
    prompt: z.string().trim().min(1).max(SCHEDULE_PROMPT_MAX).optional(),
    timeOfDay: z.string().regex(TIME_OF_DAY_PATTERN).optional(),
    days: z.array(z.enum(SCHEDULE_DAYS)).min(1).max(7).optional(),
    timezone: timezoneSchema.optional(),
    phone: z.string().regex(PHONE_E164_PATTERN).optional(),
    enabled: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("delete"),
    taskId: taskIdSchema,
  }).strict(),
  z.object({
    action: z.literal("run"),
    taskId: taskIdSchema,
  }).strict(),
]);

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const { auth, tenant, canManage } = await authenticate();
    const body = postSchema.parse(await readBoundedJsonBody(request));
    if (!canManage) return jsonError("Only owners and managers can manage schedules.", 403, correlationId);

    if (body.action === "create") {
      const decision = await consumeAlbertRateLimit("scheduled.create");
      if (!decision.allowed) return rateLimitExceededResponse(decision);
      const numbers = await enrolledNumbers(auth.supabase);
      const owner = numbers.find((number) => number.isOwner) ?? numbers[0];
      if (!owner) {
        return jsonError("Enrol a phone number on the iMessage page before scheduling a report.", 409, correlationId);
      }
      const defaultTimezone = body.timezone ?? tenant.timezone;
      const started = Date.now();
      const draft = await parseScheduleRequest({
        text: body.text,
        defaultTimezone,
        apiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        safetyIdentifier: createHash("sha256").update(`${tenant.tenant_id}:${auth.user.id}`).digest("hex"),
        signal: request.signal,
      });
      const now = new Date();
      const nextRunAt = nextScheduledRunAt(draft, now);
      if (!nextRunAt) return jsonError("That schedule couldn't be worked out. Try naming a time and the days.", 400, correlationId);
      const task = await saveScheduledTask({
        title: draft.title,
        requestText: body.text,
        prompt: draft.prompt,
        timeOfDay: draft.timeOfDay,
        days: draft.days,
        timezone: draft.timezone,
        phone: owner.phone,
        enabled: true,
        nextRunAt,
      }, auth.supabase);
      logger.info("scheduled.created", {
        tenantId: tenant.tenant_id,
        taskId: task.taskId,
        source: draft.source,
        durationMs: Date.now() - started,
      }, correlationId);
      return json({ task: serialiseTask(task), note: draft.note, source: draft.source }, 200, correlationId);
    }

    if (body.action === "run") {
      const decision = await consumeAlbertRateLimit("scheduled.run");
      if (!decision.allowed) return rateLimitExceededResponse(decision);
      const run = await requestScheduledRun({ taskId: body.taskId, runId: ulid() }, auth.supabase);
      return json({ run }, 200, correlationId);
    }

    const decision = await consumeAlbertRateLimit("scheduled.mutation");
    if (!decision.allowed) return rateLimitExceededResponse(decision);

    if (body.action === "delete") {
      const removed = await deleteScheduledTask(body.taskId, auth.supabase);
      return json({ removed }, 200, correlationId);
    }

    // update: merge the patch over the stored task and recompute the next run.
    const current = (await loadScheduledWorkspace(auth.supabase)).find((task) => task.taskId === body.taskId);
    if (!current) return jsonError("That schedule no longer exists.", 404, correlationId);
    const merged = {
      title: body.title ?? current.title,
      prompt: body.prompt ?? current.prompt,
      timeOfDay: body.timeOfDay ?? current.timeOfDay,
      days: normaliseScheduleDays(body.days ?? current.days),
      timezone: body.timezone ?? current.timezone,
      phone: body.phone ?? current.phone,
      enabled: body.enabled ?? current.enabled,
    };
    const nextRunAt = merged.enabled ? nextScheduledRunAt(merged, new Date()) : null;
    if (merged.enabled && !nextRunAt) return jsonError("That schedule isn't valid.", 400, correlationId);
    const task = await saveScheduledTask({
      taskId: current.taskId,
      requestText: current.requestText,
      ...merged,
      nextRunAt,
    }, auth.supabase);
    return json({ task: serialiseTask(task) }, 200, correlationId);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("That request wasn't valid.", 400, correlationId);
    }
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("scheduled.mutation_failed", safeErrorEvidence(error), correlationId);
    return jsonError(error instanceof Error ? error.message : "The change could not be saved.", status, correlationId);
  }
}
