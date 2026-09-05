import { z } from "zod";

import { ControlPlaneError, requireUser } from "./web-repository.js";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * Dashboard Master rows (migration 0178). The session state and report
 * documents are validated against their full schemas at the service layer
 * (services/dashboard-master); the repository treats them as opaque objects
 * so a report written by a newer session shape still loads.
 */
export const dashboardMasterRowSchema = z.object({
  reportId: ulidSchema,
  status: z.enum(["running", "completed", "failed", "abandoned"]),
  model: z.string().min(1).max(120),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  sessionState: z.record(z.string(), z.unknown()).nullish().catch(null),
  report: z.record(z.string(), z.unknown()).nullable().catch(null),
  failureNote: z.string().max(300).nullable(),
}).strict();

export const dashboardMasterPanelSchema = z.object({
  latest: dashboardMasterRowSchema.nullable(),
  running: dashboardMasterRowSchema.nullable(),
  conversationIds: z.array(ulidSchema).max(96).catch([]),
}).strict();

export type DashboardMasterRow = z.infer<typeof dashboardMasterRowSchema>;
export type DashboardMasterPanel = z.infer<typeof dashboardMasterPanelSchema>;

function parseRow(data: unknown): DashboardMasterRow {
  const parsed = dashboardMasterRowSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The dashboard returned invalid state.", 503);
  }
  return parsed.data;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    throw new ControlPlaneError(`The dashboard could not be saved: ${error.message}`, 503);
  }
  return data;
}

export async function loadDashboardMasterPanel(): Promise<DashboardMasterPanel> {
  const data = await rpc("albert_dashboard_master_panel", {});
  const parsed = dashboardMasterPanelSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The dashboard panel returned invalid state.", 503);
  }
  return parsed.data;
}

export async function beginDashboardMasterSession(input: Readonly<{
  reportId: string;
  model: string;
  reasoningEffort: string;
  state: Record<string, unknown>;
}>): Promise<DashboardMasterRow> {
  return parseRow(await rpc("albert_dashboard_master_begin", {
    p_report_id: input.reportId,
    p_model: input.model,
    p_reasoning_effort: input.reasoningEffort,
    p_state: input.state,
  }));
}

export async function saveDashboardMasterState(input: Readonly<{
  reportId: string;
  state: Record<string, unknown>;
}>): Promise<DashboardMasterRow> {
  return parseRow(await rpc("albert_dashboard_master_save_state", {
    p_report_id: input.reportId,
    p_state: input.state,
  }));
}

export async function completeDashboardMasterSession(input: Readonly<{
  reportId: string;
  report: Record<string, unknown>;
}>): Promise<DashboardMasterRow> {
  return parseRow(await rpc("albert_dashboard_master_complete", {
    p_report_id: input.reportId,
    p_report: input.report,
  }));
}

export async function failDashboardMasterSession(input: Readonly<{
  reportId: string;
  note: string | null;
}>): Promise<DashboardMasterRow> {
  return parseRow(await rpc("albert_dashboard_master_fail", {
    p_report_id: input.reportId,
    p_note: input.note,
  }));
}
