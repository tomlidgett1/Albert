"use client";

/**
 * Dashboard Master session controller: the browser-side orchestrator for the
 * daily deep-dive (the same shape as the Proactive and Swarm fleets — the
 * open tab is the scheduler). The server registers the session and assigns
 * objectives; this controller executes each worker as a real omni
 * conversation turn, captures governed evidence from the stream, records
 * findings, asks the server to direct the next round, and finally requests
 * the composed report.
 */
import {
  DASHBOARD_MASTER_EFFORT,
  DASHBOARD_MASTER_MODEL,
} from "@/services/dashboard-master/src/contracts";
import {
  DASHBOARD_WORKER_CONCURRENCY,
  captureDashboardWorkerEvent,
  newDashboardWorkerEvidence,
} from "@/services/dashboard-master/src/session";
import type { OmniTraceEventInput } from "@/packages/albert-omni/src/runtime";

export type DashboardMasterWorkerPhase = "pending" | "running" | "recording" | "done" | "failed";

export type DashboardMasterWorkerLive = Readonly<{
  key: string;
  title: string;
  round: number;
  phase: DashboardMasterWorkerPhase;
  statusLine: string;
  queries: number;
}>;

export type DashboardMasterSnapshot = Readonly<{
  active: boolean;
  reportId: string | null;
  phase: "idle" | "starting" | "investigating" | "composing" | "completed" | "failed";
  roundLabel: string;
  workers: readonly DashboardMasterWorkerLive[];
  startedAtMs: number | null;
  error: string | null;
  /** Bumps when a session completes so the workspace re-fetches the panel. */
  settledCount: number;
}>;

type SessionTurn = Readonly<{ key: string; round: number; title: string; message: string }>;

const IDLE: DashboardMasterSnapshot = Object.freeze({
  active: false,
  reportId: null,
  phase: "idle",
  roundLabel: "",
  workers: [],
  startedAtMs: null,
  error: null,
  settledCount: 0,
});

let snapshot: DashboardMasterSnapshot = IDLE;
const listeners = new Set<() => void>();
let currentRunToken = 0;

function emit(next: Partial<DashboardMasterSnapshot>): void {
  snapshot = Object.freeze({ ...snapshot, ...next });
  for (const listener of listeners) listener();
}

function setWorker(key: string, patch: Partial<DashboardMasterWorkerLive>): void {
  emit({
    workers: snapshot.workers.map((worker) => (
      worker.key === key ? Object.freeze({ ...worker, ...patch }) : worker
    )),
  });
}

export function subscribeDashboardMasterRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dashboardMasterRunSnapshot(): DashboardMasterSnapshot {
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

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string"
      ? payload.error
      : `The dashboard request failed (${response.status}).`);
  }
  return payload ?? {};
}

async function runWorkerTurn(runToken: number, reportId: string, turn: SessionTurn): Promise<void> {
  const startedAt = Date.now();
  setWorker(turn.key, { phase: "running", statusLine: "Contacting Albert…" });
  const evidence = newDashboardWorkerEvidence();
  let conversationId: string | null = null;
  let failed = false;
  try {
    let response: Response | null = null;
    for (let attempt = 0; ; attempt += 1) {
      if (runToken !== currentRunToken) return;
      response = await fetch("/api/omni-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: turn.message,
          preferences: {
            model: DASHBOARD_MASTER_MODEL,
            reasoningEffort: DASHBOARD_MASTER_EFFORT,
            fastMode: false,
          },
        }),
      });
      if (response.ok || attempt >= 6) break;
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      const message = payload?.error || `The investigation could not be started (${response.status}).`;
      const atCapacity = response.status === 429
        || response.status === 503
        || /at capacity|rate limit|try again/iu.test(message);
      if (!atCapacity || runToken !== currentRunToken) throw new Error(message);
      setWorker(turn.key, { statusLine: `Albert is at capacity, retrying in 45s (attempt ${attempt + 1})` });
      await new Promise((resolve) => setTimeout(resolve, 45_000));
    }
    if (!response || !response.ok || !response.body) {
      throw new Error("The investigation could not be started.");
    }
    conversationId = response.headers.get("X-Albert-Conversation-Id");
    setWorker(turn.key, { statusLine: "Reading the connected data…" });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
        captureDashboardWorkerEvent(evidence, event as unknown as OmniTraceEventInput);
        if (event.type === "query") {
          setWorker(turn.key, {
            queries: evidence.queries,
            statusLine: typeof event.topic === "string"
              ? `Querying ${event.topic.slice(0, 120)}…`
              : `Running query ${evidence.queries}…`,
          });
        } else if (event.type === "narrative" && typeof event.text === "string" && event.purpose !== "acknowledgement" && event.purpose !== "reasoning_summary") {
          setWorker(turn.key, { statusLine: event.text.slice(0, 160) });
        }
      }
      if (done) break;
    }
    if (!evidence.answer) throw new Error("The investigation ended before an answer arrived.");
  } catch (error) {
    failed = true;
    setWorker(turn.key, {
      statusLine: error instanceof Error ? error.message.slice(0, 160) : "The investigation failed.",
    });
  }
  if (runToken !== currentRunToken) return;

  setWorker(turn.key, { phase: "recording", statusLine: failed ? "Recording the miss…" : "Recording the finding…" });
  await postJson("/api/dashboard-master/finding", {
    reportId,
    key: turn.key,
    answerState: evidence.answerState,
    answer: evidence.answer.slice(0, 120_000),
    tables: evidence.tables.slice(-3),
    charts: evidence.charts.slice(-2),
    queries: Math.min(evidence.queries, 200),
    durationMs: Math.min(Date.now() - startedAt, 2 * 60 * 60_000 - 1),
    failed: failed || !evidence.answer,
    ...(conversationId ? { conversationId } : {}),
  });
  setWorker(turn.key, {
    phase: failed || !evidence.answer ? "failed" : "done",
    statusLine: failed ? "No usable finding." : "Finding recorded.",
  });
}

async function runTurns(runToken: number, reportId: string, turns: readonly SessionTurn[]): Promise<void> {
  emit({
    phase: "investigating",
    roundLabel: `Round ${turns[0]?.round ?? 1} · ${turns.length} objectives`,
    workers: [
      ...snapshot.workers,
      ...turns.map((turn) => Object.freeze({
        key: turn.key,
        title: turn.title,
        round: turn.round,
        phase: "pending" as const,
        statusLine: "Waiting for a slot…",
        queries: 0,
      })),
    ],
  });
  const queue = [...turns];
  const workers = Array.from({ length: Math.min(DASHBOARD_WORKER_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      if (runToken !== currentRunToken) return;
      const turn = queue.shift();
      if (!turn) return;
      await runWorkerTurn(runToken, reportId, turn);
    }
  });
  await Promise.all(workers);
}

export function startDashboardMasterSession(): void {
  if (snapshot.active) return;
  const runToken = ++currentRunToken;
  snapshot = Object.freeze({
    ...IDLE,
    active: true,
    phase: "starting" as const,
    startedAtMs: Date.now(),
    settledCount: snapshot.settledCount,
  });
  for (const listener of listeners) listener();

  void (async () => {
    try {
      const begun = await postJson("/api/dashboard-master/session", {});
      const reportId = typeof begun.reportId === "string" ? begun.reportId : null;
      let turns = Array.isArray(begun.turns) ? begun.turns as SessionTurn[] : [];
      if (!reportId) throw new Error("The dashboard session did not start.");
      emit({ reportId });

      // Round loop: execute the assigned turns, then ask the server to direct
      // the next round until the session reaches compose.
      for (let guard = 0; guard < 6; guard += 1) {
        if (runToken !== currentRunToken) return;
        if (turns.length > 0) await runTurns(runToken, reportId, turns);
        if (runToken !== currentRunToken) return;
        const directed = await postJson("/api/dashboard-master/direct", { reportId });
        const state = directed.state as { phase?: string } | undefined;
        turns = Array.isArray(directed.turns) ? directed.turns as SessionTurn[] : [];
        if (state?.phase === "compose") break;
        if (turns.length === 0) break;
      }
      if (runToken !== currentRunToken) return;

      emit({ phase: "composing", roundLabel: "Writing the report…" });
      await postJson("/api/dashboard-master/compose", { reportId });
      if (runToken !== currentRunToken) return;
      emit({ active: false, phase: "completed", settledCount: snapshot.settledCount + 1 });
    } catch (error) {
      if (runToken !== currentRunToken) return;
      emit({
        active: false,
        phase: "failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "The dashboard session failed.",
        settledCount: snapshot.settledCount + 1,
      });
    }
  })();
}

export function stopDashboardMasterSession(): void {
  currentRunToken += 1;
  emit({ active: false, phase: "idle", workers: [], roundLabel: "" });
}
