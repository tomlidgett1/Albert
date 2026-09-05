import { ControlPlaneError, requireUser } from "../../control-plane/src/web-repository.js";
import {
  dashboardPlanEventSchema,
  type DashboardPlanEvent,
} from "./contracts.js";

export type DashboardBuildTable = Readonly<{
  tableEventId: string;
  resultId: string;
  caption: string;
  replayable: boolean;
}>;

export type DashboardBuildArtifacts = Readonly<{
  plan: DashboardPlanEvent;
  tablesByResultId: ReadonlyMap<string, DashboardBuildTable>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a build turn's composed plan and governed tables from the persisted
 * conversation trace — never from a client payload. The history RPC enforces
 * tenant + author scoping, and `albert_dashboard_pin` independently re-checks
 * every table's replay reference, so apply only ever pins what the trusted
 * trace records.
 */
export async function loadDashboardBuildArtifacts(input: Readonly<{
  conversationId: string;
  turnId: string;
}>): Promise<DashboardBuildArtifacts> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_conversation_history", {
    p_conversation_id: input.conversationId,
    p_after_sequence: 0,
  });
  if (error) {
    throw new ControlPlaneError(
      error.code === "P0002" ? "The build conversation was not found." : "The build trace could not be loaded.",
      error.code === "P0002" ? 404 : 503,
    );
  }
  const payload = Array.isArray(data) ? data[0] : data;
  const turns = isRecord(payload) && Array.isArray(payload.turns) ? payload.turns : [];
  const turn = turns.find((candidate) => isRecord(candidate) && candidate.turn_id === input.turnId);
  if (!isRecord(turn)) {
    throw new ControlPlaneError("The build turn was not found.", 404);
  }
  const events = Array.isArray(turn.events) ? turn.events.filter(isRecord) : [];

  let plan: DashboardPlanEvent | null = null;
  const tablesByResultId = new Map<string, DashboardBuildTable>();
  for (const event of events) {
    if (event.type === "dashboard_plan") {
      const parsed = dashboardPlanEventSchema.safeParse(event);
      // The last accepted plan wins, matching the compose tool's contract.
      if (parsed.success) plan = parsed.data;
      continue;
    }
    if (event.type !== "table") continue;
    const resultId = typeof event.resultId === "string" ? event.resultId : null;
    const tableEventId = typeof event.id === "string" ? event.id : null;
    if (!resultId || !tableEventId) continue;
    const replay = isRecord(event.dashboardReplay) ? event.dashboardReplay : null;
    tablesByResultId.set(resultId, {
      tableEventId,
      resultId,
      caption: typeof event.caption === "string" ? event.caption : "Governed table",
      replayable: Boolean(
        replay
        && (
          (
            replay.kind === "cube_v3"
            && typeof replay.queryEventId === "string"
            && replay.queryEventId.length > 0
          )
          || (
            // Derived pivots: the relay paired every source table event and
            // stamped the transform digest, so the pin RPC can re-verify.
            replay.kind === "derived_v1"
            && Array.isArray(replay.sourceTableEventIds)
            && replay.sourceTableEventIds.length > 0
            && typeof replay.transformDigest === "string"
            && /^[0-9a-f]{64}$/u.test(replay.transformDigest)
          )
        ),
      ),
    });
  }
  if (!plan) {
    throw new ControlPlaneError("The build turn has no composed dashboard plan.", 409);
  }
  return Object.freeze({ plan, tablesByResultId });
}
