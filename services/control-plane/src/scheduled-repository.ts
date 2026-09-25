/**
 * Scheduled reports repository (ADR 0131, migration 0183): the tenant's
 * schedules and their runs, read for any active member and written through
 * owner/manager-gated RPCs. The imessage-bridge scheduler talks to the same
 * RPC surface through the owner session (see services/imessage-bridge).
 */
import { z } from "zod";
import {
  scheduledRunSchema,
  scheduledTaskSchema,
  toScheduledRun,
  toScheduledTask,
  type ScheduleDay,
  type ScheduledRun,
  type ScheduledTask,
} from "../../scheduled/src/contracts.js";
import { ControlPlaneError, requireUser } from "./web-repository.js";

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

const workspaceSchema = z.object({
  tasks: z.array(scheduledTaskSchema),
}).passthrough();

function singleton(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

function migrationMissing(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883" || error?.code === "42P01";
}

function mapError(error: { code?: string; message?: string }, fallback: string): ControlPlaneError {
  const message = error.message ?? "";
  if (migrationMissing(error)) return new ControlPlaneError("The Scheduled migration is not deployed.", 503);
  if (/insufficient role/iu.test(message)) return new ControlPlaneError("Only owners and managers can manage schedules.", 403);
  if (/not enrolled/iu.test(message)) return new ControlPlaneError("That number isn't enrolled for iMessage. Enrol it on the iMessage page first.", 400);
  if (/E\.164/iu.test(message)) return new ControlPlaneError("That doesn't look like a full phone number.", 400);
  if (/20 schedules/iu.test(message)) return new ControlPlaneError("This organisation already has 20 schedules - remove one first.", 409);
  if (/already in progress/iu.test(message)) return new ControlPlaneError("That schedule is already running. Wait for it to finish.", 409);
  if (error.code === "P0002" || /no such schedule/iu.test(message)) return new ControlPlaneError("That schedule no longer exists.", 404);
  if (error.code === "22023") return new ControlPlaneError(message || "That schedule isn't valid.", 400);
  return new ControlPlaneError(fallback, 503);
}

export async function loadScheduledWorkspace(supabaseClient?: SupabaseClient): Promise<readonly ScheduledTask[]> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_scheduled_workspace");
  if (error) throw mapError(error, "Schedules could not be loaded.");
  const parsed = workspaceSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("Schedules returned invalid state.", 503);
  return Object.freeze(parsed.data.tasks.map(toScheduledTask));
}

export type SaveScheduledTaskInput = Readonly<{
  taskId?: string;
  title: string;
  requestText: string;
  prompt: string;
  timeOfDay: string;
  days: readonly ScheduleDay[];
  timezone: string;
  phone: string;
  enabled: boolean;
  nextRunAt: Date | null;
}>;

export async function saveScheduledTask(
  input: SaveScheduledTaskInput,
  supabaseClient?: SupabaseClient,
): Promise<ScheduledTask> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_scheduled_task_save", {
    p_task_id: input.taskId ?? null,
    p_title: input.title,
    p_request_text: input.requestText,
    p_prompt: input.prompt,
    p_time_of_day: input.timeOfDay,
    p_days: [...input.days],
    p_timezone: input.timezone,
    p_phone: input.phone,
    p_enabled: input.enabled,
    p_next_run_at: input.nextRunAt ? input.nextRunAt.toISOString() : null,
  });
  if (error) throw mapError(error, "The schedule could not be saved.");
  const parsed = scheduledTaskSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The schedule returned invalid state.", 503);
  return toScheduledTask(parsed.data);
}

export async function deleteScheduledTask(taskId: string, supabaseClient?: SupabaseClient): Promise<boolean> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_scheduled_task_delete", { p_task_id: taskId });
  if (error) throw mapError(error, "The schedule could not be removed.");
  return data === true;
}

export async function requestScheduledRun(
  input: Readonly<{ taskId: string; runId: string }>,
  supabaseClient?: SupabaseClient,
): Promise<ScheduledRun> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_scheduled_run_request", {
    p_task_id: input.taskId,
    p_run_id: input.runId,
  });
  if (error) throw mapError(error, "The run could not be queued.");
  const parsed = scheduledRunSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The run returned invalid state.", 503);
  return toScheduledRun(parsed.data);
}
