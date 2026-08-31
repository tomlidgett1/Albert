"use client";

/**
 * Natural-language dashboard build controller (ADR 0129): the browser-side
 * driver, same shape as the Proactive / Swarm / Dashboard Master fleets — the
 * open tab is the scheduler. One architect turn runs as a real omni
 * conversation with `dashboardBuild: true`; the live tasks and query counter
 * come straight off its SSE trace, and when the stream ends the composed plan
 * is applied server-side from the persisted trace.
 */

export type DashboardBuildTask = Readonly<{ id: string; label: string; completed: boolean }>;

export type DashboardBuildSnapshot = Readonly<{
  active: boolean;
  phase: "idle" | "starting" | "designing" | "applying" | "completed" | "failed";
  instruction: string;
  statusLine: string;
  tasks: readonly DashboardBuildTask[];
  queries: number;
  plannedTiles: number;
  conversationId: string | null;
  summary: string | null;
  appliedTitle: string | null;
  appliedTimeframe: string | null;
  skipped: readonly string[];
  error: string | null;
  /** Bumps when a build settles so the workspace re-fetches the dashboard. */
  settledCount: number;
}>;

const IDLE: DashboardBuildSnapshot = Object.freeze({
  active: false,
  phase: "idle",
  instruction: "",
  statusLine: "",
  tasks: [],
  queries: 0,
  plannedTiles: 0,
  conversationId: null,
  summary: null,
  appliedTitle: null,
  appliedTimeframe: null,
  skipped: [],
  error: null,
  settledCount: 0,
});

let snapshot: DashboardBuildSnapshot = IDLE;
const listeners = new Set<() => void>();
let currentRunToken = 0;
let currentAbort: AbortController | null = null;

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

type ParsedSseBlock = Readonly<{ event: string; data: string }>;

function parseSseBlock(block: string): ParsedSseBlock | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

async function postJson(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string"
      ? payload.error
      : `The dashboard request failed (${response.status}).`);
  }
  return payload ?? {};
}

function consumeTraceEvent(event: Record<string, unknown>): void {
  if (event.type === "tasks" && Array.isArray(event.items)) {
    emit({
      tasks: event.items.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const task = item as Record<string, unknown>;
        if (typeof task.id !== "string" || typeof task.label !== "string") return [];
        return [Object.freeze({ id: task.id, label: task.label, completed: task.completed === true })];
      }),
    });
    return;
  }
  if (event.type === "query") {
    emit({
      queries: snapshot.queries + 1,
      statusLine: typeof event.name === "string" && event.name
        ? `Running: ${event.name.slice(0, 120)}`
        : `Running query ${snapshot.queries + 1}…`,
    });
    return;
  }
  if (event.type === "research" && typeof event.label === "string") {
    emit({ statusLine: event.label.slice(0, 160) });
    return;
  }
  if (
    event.type === "narrative"
    && typeof event.text === "string"
    && event.purpose !== "acknowledgement"
    && event.purpose !== "reasoning_summary"
  ) {
    emit({ statusLine: event.text.slice(0, 160) });
    return;
  }
  if (event.type === "dashboard_plan" && Array.isArray(event.tiles)) {
    emit({
      plannedTiles: event.tiles.length,
      statusLine: `Dashboard composed: ${event.tiles.length} tiles`,
    });
    return;
  }
  if (event.type === "answer" && typeof event.text === "string") {
    emit({ summary: event.text.slice(0, 2_000) });
  }
}

export function startDashboardBuild(instruction: string): void {
  const trimmed = instruction.trim();
  if (snapshot.active || trimmed.length < 4) return;
  const runToken = ++currentRunToken;
  const abort = new AbortController();
  currentAbort = abort;
  snapshot = Object.freeze({
    ...IDLE,
    active: true,
    phase: "starting" as const,
    instruction: trimmed,
    statusLine: "Preparing the brief…",
    settledCount: snapshot.settledCount,
  });
  for (const listener of listeners) listener();

  void (async () => {
    try {
      const brief = await postJson("/api/dashboard/build", { instruction: trimmed }, abort.signal);
      const message = typeof brief.message === "string" ? brief.message : null;
      if (!message) throw new Error("The build brief could not be composed.");
      if (runToken !== currentRunToken) return;

      emit({ phase: "designing", statusLine: "Albert is designing your dashboard…" });
      let response: Response | null = null;
      for (let attempt = 0; ; attempt += 1) {
        if (runToken !== currentRunToken) return;
        response = await fetch("/api/omni-conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            preferences: brief.preferences ?? {},
            dashboardBuild: true,
          }),
          signal: abort.signal,
        });
        if (response.ok || attempt >= 3) break;
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        const detail = payload?.error || `The build could not be started (${response.status}).`;
        const atCapacity = response.status === 429
          || response.status === 503
          || /at capacity|rate limit|try again/iu.test(detail);
        if (!atCapacity) throw new Error(detail);
        emit({ statusLine: `Albert is at capacity, retrying in 30s (attempt ${attempt + 1})` });
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
      if (!response || !response.body) throw new Error("The build could not be started.");
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || `The build could not be started (${response.status}).`);
      }
      const conversationId = response.headers.get("X-Albert-Conversation-Id");
      const turnId = response.headers.get("X-Albert-Turn-Id");
      if (!conversationId || !turnId) throw new Error("The build turn is missing its identifiers.");
      emit({ conversationId });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawPlan = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const normalized = buffer.replace(/\r\n/gu, "\n");
        const blocks = normalized.split("\n\n");
        buffer = done ? "" : (blocks.pop() ?? "");
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed || parsed.event !== "trace") continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(parsed.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.type === "dashboard_plan") sawPlan = true;
          if (runToken === currentRunToken) consumeTraceEvent(event);
        }
        if (done) break;
      }
      if (runToken !== currentRunToken) return;
      if (!sawPlan) {
        throw new Error(snapshot.summary
          ? `Albert could not compose the dashboard: ${snapshot.summary.slice(0, 240)}`
          : "The build finished without a composed dashboard.");
      }

      emit({ phase: "applying", statusLine: "Placing the tiles…" });
      const applied = await postJson("/api/dashboard/build/apply", { conversationId, turnId }, abort.signal);
      if (runToken !== currentRunToken) return;
      const summaryPayload = (applied.applied ?? {}) as Record<string, unknown>;
      emit({
        active: false,
        phase: "completed",
        statusLine: "Dashboard ready.",
        appliedTitle: typeof summaryPayload.dashboardTitle === "string" ? summaryPayload.dashboardTitle : null,
        appliedTimeframe: typeof summaryPayload.timeframe === "string" ? summaryPayload.timeframe : null,
        skipped: Array.isArray(summaryPayload.skipped)
          ? summaryPayload.skipped.filter((entry): entry is string => typeof entry === "string")
          : [],
        settledCount: snapshot.settledCount + 1,
      });
    } catch (error) {
      if (runToken !== currentRunToken) return;
      const aborted = error instanceof DOMException && error.name === "AbortError";
      emit({
        active: false,
        phase: aborted ? "idle" : "failed",
        error: aborted
          ? null
          : (error instanceof Error ? error.message.slice(0, 300) : "The dashboard build failed."),
        settledCount: snapshot.settledCount + 1,
      });
    } finally {
      if (currentAbort === abort) currentAbort = null;
    }
  })();
}

/**
 * Stops watching and applying. The architect turn itself keeps running
 * server-side (the conversation stays in history), but nothing is applied.
 */
export function stopDashboardBuild(): void {
  currentRunToken += 1;
  currentAbort?.abort();
  currentAbort = null;
  emit({ active: false, phase: "idle", statusLine: "", tasks: [], error: null });
}

/** Clears a settled build's banner state. */
export function dismissDashboardBuildResult(): void {
  if (snapshot.active) return;
  emit({
    phase: "idle",
    error: null,
    summary: null,
    appliedTitle: null,
    appliedTimeframe: null,
    skipped: [],
    tasks: [],
    queries: 0,
    plannedTiles: 0,
    statusLine: "",
    instruction: "",
  });
}
