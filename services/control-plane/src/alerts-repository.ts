/**
 * Heads-up alerts repository (ADR 0132, migration 0185): the tenant's
 * trigger switches and recipients, the latest reading per trigger, the
 * fired events and the evaluation runs. Reads for any active member;
 * switching, choosing recipients and requesting a check are owner/manager
 * actions gated in the RPCs. The imessage-bridge evaluator talks to the
 * same RPC surface through the owner session.
 */
import { z } from "zod";
import {
  alertEvaluationSchema,
  alertEventSchema,
  alertSettingsSchema,
  alertTriggerRowSchema,
  alertTriggerStateSchema,
  toAlertEvaluation,
  toAlertEvent,
  toAlertSettings,
  toAlertTriggerRow,
  toAlertTriggerState,
  type AlertEvaluation,
  type AlertEvent,
  type AlertSettings,
  type AlertTriggerRow,
  type AlertTriggerState,
} from "../../alerts/src/contracts.js";
import { ControlPlaneError, requireUser } from "./web-repository.js";

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

const workspaceSchema = z.object({
  settings: alertSettingsSchema,
  triggers: z.array(alertTriggerRowSchema),
  states: z.array(alertTriggerStateSchema),
  events: z.array(alertEventSchema),
  lastEvaluation: alertEvaluationSchema.nullish(),
  openEvaluation: alertEvaluationSchema.nullish(),
}).passthrough();

export type AlertsWorkspace = Readonly<{
  settings: AlertSettings;
  triggers: readonly AlertTriggerRow[];
  states: readonly AlertTriggerState[];
  events: readonly AlertEvent[];
  lastEvaluation: AlertEvaluation | null;
  openEvaluation: AlertEvaluation | null;
}>;

function singleton(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

function migrationMissing(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883" || error?.code === "42P01";
}

function mapError(error: { code?: string; message?: string }, fallback: string): ControlPlaneError {
  const message = error.message ?? "";
  if (migrationMissing(error)) return new ControlPlaneError("The Alerts migration is not deployed.", 503);
  if (/insufficient role/iu.test(message)) return new ControlPlaneError("Only owners and managers can manage alerts.", 403);
  if (/not enrolled/iu.test(message)) return new ControlPlaneError("That number isn't enrolled for iMessage. Enrol it on the iMessage page first.", 400);
  if (/E\.164/iu.test(message)) return new ControlPlaneError("That doesn't look like a full phone number.", 400);
  if (/20 recipients/iu.test(message)) return new ControlPlaneError("An alert can go to at most 20 numbers.", 400);
  if (/already in progress/iu.test(message)) return new ControlPlaneError("A check is already running. Give it a minute.", 409);
  if (error.code === "22023") return new ControlPlaneError(message || "That change isn't valid.", 400);
  return new ControlPlaneError(fallback, 503);
}

export async function loadAlertsWorkspace(supabaseClient?: SupabaseClient): Promise<AlertsWorkspace> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_alerts_workspace");
  if (error) throw mapError(error, "Alerts could not be loaded.");
  const parsed = workspaceSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("Alerts returned invalid state.", 503);
  return Object.freeze({
    settings: toAlertSettings(parsed.data.settings),
    triggers: Object.freeze(parsed.data.triggers.map(toAlertTriggerRow)),
    states: Object.freeze(parsed.data.states.map(toAlertTriggerState)),
    events: Object.freeze(parsed.data.events.map(toAlertEvent)),
    lastEvaluation: parsed.data.lastEvaluation ? toAlertEvaluation(parsed.data.lastEvaluation) : null,
    openEvaluation: parsed.data.openEvaluation ? toAlertEvaluation(parsed.data.openEvaluation) : null,
  });
}

export async function saveAlertTrigger(
  input: Readonly<{ triggerKey: string; enabled: boolean; recipients: readonly string[]; config?: Readonly<Record<string, unknown>> }>,
  supabaseClient?: SupabaseClient,
): Promise<AlertTriggerRow> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_alerts_trigger_save", {
    p_trigger_key: input.triggerKey,
    p_enabled: input.enabled,
    p_recipients: [...input.recipients],
    p_config: input.config ?? null,
  });
  if (error) throw mapError(error, "The alert could not be saved.");
  const parsed = alertTriggerRowSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The alert returned invalid state.", 503);
  return toAlertTriggerRow(parsed.data);
}

export async function requestAlertsCheck(
  input: Readonly<{ evaluationId: string }>,
  supabaseClient?: SupabaseClient,
): Promise<AlertEvaluation> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_alerts_check_request", { p_evaluation_id: input.evaluationId });
  if (error) throw mapError(error, "The check could not be queued.");
  const parsed = alertEvaluationSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The check returned invalid state.", 503);
  return toAlertEvaluation(parsed.data);
}
