"use client";

/**
 * Natural-language dashboard build state (ADR 0129, reworked for dashboard
 * mode; dashboards plural and element edits per ADR 0134). The chat pipeline
 * owns the architect turn itself — the brief comes from /api/dashboard/build
 * and streams through /api/omni-conversation with `dashboardBuild: true`, so
 * the working trail lives in the conversation. This store tracks the build
 * lifecycle around that turn: designing while the turn streams, applying once
 * its composed plan is persisted, and the applied summary the workspace and
 * panel read. `settledCount` bumps whenever a build settles so dashboard
 * views re-fetch their document.
 */

export type DashboardBuildPhase = "idle" | "designing" | "applying" | "applied" | "failed";

export type DashboardBuildTarget = Readonly<{
  /** The dashboard being built; null before a dashboard is known. */
  dashboardId: string | null;
  /** Set for an element edit: only this tile is rebuilt, in place. */
  editTile?: Readonly<{ tileId: string; title: string }> | null;
}>;

export type DashboardBuildSnapshot = Readonly<{
  phase: DashboardBuildPhase;
  /** True while a build turn is streaming or its plan is being applied. */
  active: boolean;
  instruction: string;
  dashboardId: string | null;
  /** The element an element edit is rebuilding (null for a whole build). */
  editTileId: string | null;
  editTileTitle: string | null;
  conversationId: string | null;
  turnId: string | null;
  appliedTitle: string | null;
  appliedTimeframe: string | null;
  /** After an element edit applies: the replacement tile's id. */
  appliedTileId: string | null;
  skipped: readonly string[];
  error: string | null;
  /** Bumps when a build settles so dashboard views re-fetch the document. */
  settledCount: number;
}>;

const IDLE: DashboardBuildSnapshot = Object.freeze({
  phase: "idle",
  active: false,
  instruction: "",
  dashboardId: null,
  editTileId: null,
  editTileTitle: null,
  conversationId: null,
  turnId: null,
  appliedTitle: null,
  appliedTimeframe: null,
  appliedTileId: null,
  skipped: [],
  error: null,
  settledCount: 0,
});

let snapshot: DashboardBuildSnapshot = IDLE;
const listeners = new Set<() => void>();
let currentRunToken = 0;

function emit(next: Partial<DashboardBuildSnapshot>): void {
  snapshot = Object.freeze({ ...snapshot, ...next });
  for (const listener of listeners) listener();
}

export function subscribeDashboardBuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dashboardBuildSnapshot(): DashboardBuildSnapshot {
  return snapshot;
}

/** A dashboard-mode send has started streaming its architect turn. */
export function beginDashboardBuildTurn(instruction: string, target?: DashboardBuildTarget): number {
  currentRunToken += 1;
  emit({
    phase: "designing",
    active: true,
    instruction: instruction.slice(0, 2_000),
    dashboardId: target?.dashboardId ?? null,
    editTileId: target?.editTile?.tileId ?? null,
    editTileTitle: target?.editTile?.title ?? null,
    conversationId: null,
    turnId: null,
    appliedTitle: null,
    appliedTimeframe: null,
    appliedTileId: null,
    skipped: [],
    error: null,
  });
  return currentRunToken;
}

/** The streaming response returned its immutable turn identifiers. */
export function attachDashboardBuildTurn(
  runToken: number,
  ids: Readonly<{ conversationId: string; turnId: string }>,
): void {
  if (runToken !== currentRunToken) return;
  emit({ conversationId: ids.conversationId, turnId: ids.turnId });
}

/** The brief route resolved (or created) the dashboard the turn targets. */
export function attachDashboardBuildDashboard(runToken: number, dashboardId: string): void {
  if (runToken !== currentRunToken) return;
  if (snapshot.dashboardId === dashboardId) return;
  emit({ dashboardId });
}

/** The user stopped the turn or left the build; nothing is applied. */
export function stopDashboardBuildTurn(runToken?: number): void {
  if (runToken !== undefined && runToken !== currentRunToken) return;
  currentRunToken += 1;
  if (snapshot.phase === "idle") return;
  emit({
    phase: "idle",
    active: false,
    error: null,
    editTileId: null,
    editTileTitle: null,
    settledCount: snapshot.settledCount + 1,
  });
}

/** A build turn ended without a composed plan: surface why, apply nothing. */
export function failDashboardBuildTurn(runToken: number, message: string): void {
  if (runToken !== currentRunToken) return;
  emit({
    phase: "failed",
    active: false,
    error: message.slice(0, 300),
    settledCount: snapshot.settledCount + 1,
  });
}

/**
 * A build turn finished with a composed `dashboard_plan`: apply it from the
 * persisted trace. The server independently re-verifies every replay
 * reference, so only replayable governed results become tiles. An element
 * edit replaces its one tile in place; a whole build replaces the dashboard.
 */
export function applyDashboardBuildTurn(
  runToken: number,
  ids: Readonly<{ conversationId: string; turnId: string }>,
): void {
  if (runToken !== currentRunToken) return;
  const dashboardId = snapshot.dashboardId;
  const replaceTileId = snapshot.editTileId;
  emit({ phase: "applying", active: true, conversationId: ids.conversationId, turnId: ids.turnId });
  void (async () => {
    try {
      const response = await fetch("/api/dashboard/build/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...ids,
          ...(dashboardId ? { dashboardId } : {}),
          ...(replaceTileId ? { replaceTileId } : {}),
        }),
      });
      const payload = await response.json().catch(() => null) as Readonly<{
        applied?: Readonly<{
          dashboardId?: unknown;
          dashboardTitle?: unknown;
          timeframe?: unknown;
          skipped?: unknown;
          newTileId?: unknown;
        }>;
        error?: string;
      }> | null;
      if (runToken !== currentRunToken) return;
      if (!response.ok) {
        throw new Error(payload?.error || `The dashboard could not be applied (${response.status}).`);
      }
      const applied = payload?.applied ?? {};
      emit({
        phase: "applied",
        active: false,
        dashboardId: typeof applied.dashboardId === "string" ? applied.dashboardId : dashboardId,
        appliedTitle: typeof applied.dashboardTitle === "string" ? applied.dashboardTitle : null,
        appliedTimeframe: typeof applied.timeframe === "string" ? applied.timeframe : null,
        appliedTileId: typeof applied.newTileId === "string" ? applied.newTileId : null,
        skipped: Array.isArray(applied.skipped)
          ? applied.skipped.filter((entry): entry is string => typeof entry === "string")
          : [],
        error: null,
        editTileId: null,
        editTileTitle: null,
        settledCount: snapshot.settledCount + 1,
      });
    } catch (error) {
      if (runToken !== currentRunToken) return;
      emit({
        phase: "failed",
        active: false,
        error: error instanceof Error ? error.message.slice(0, 300) : "The dashboard build could not be applied.",
        settledCount: snapshot.settledCount + 1,
      });
    }
  })();
}

/** Clears a settled build's banner state. */
export function dismissDashboardBuildResult(): void {
  if (snapshot.active) return;
  emit({
    phase: "idle",
    instruction: "",
    error: null,
    editTileId: null,
    editTileTitle: null,
    appliedTitle: null,
    appliedTimeframe: null,
    appliedTileId: null,
    skipped: [],
  });
}
