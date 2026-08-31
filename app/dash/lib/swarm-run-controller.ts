/**
 * Client orchestrator for a Codex Swarm run (ADR 0120).
 *
 * Lives at module scope so switching dash tabs never aborts the fleet.
 * Each agent is one POST to /api/codex-conversation. Measure and explain
 * agents run first; challenge and reconcile agents run as a second wave
 * briefed with the first wave's distilled findings, so they argue against
 * a real story. When every agent settles, the controller asks
 * /api/swarm/synthesis to write the parent answer.
 */
import {
  appendSwarmBrief,
  buildSwarmWaveBrief,
  splitSwarmWaves,
  type SwarmWaveFinding,
} from "@/services/swarm/src/worker-brief";

export type SwarmAgentPhase =
  | "pending"
  | "starting"
  | "researching"
  | "recording"
  | "done"
  | "failed"
  | "stopped";

export type SwarmRunKind = "question" | "sales-deep" | "super-agent";

/** Which harness executes the worker turns. */
export type SwarmRunRuntime = "codex" | "omni";

export type SwarmAgentLiveState = Readonly<{
  key: string;
  title: string;
  tagline: string;
  role: string;
  phase: SwarmAgentPhase;
  statusLine: string;
  queriesSeen: number;
  headline: string | null;
  answerState: string | null;
  conversationId: string | null;
  turnId: string | null;
  error: string | null;
  /** Latest provider reasoning summary streamed by this child turn. */
  reasoningSummary?: string | null;
}>;

export type SwarmRunSnapshot = Readonly<{
  runId: string | null;
  parentConversationId: string | null;
  parentTurnId: string | null;
  question: string | null;
  periodLabel: string | null;
  kind: SwarmRunKind;
  runtime: SwarmRunRuntime;
  startedAtMs: number | null;
  durationMs: number | null;
  elapsedMs: number;
  checkpointIntervalMs: number | null;
  checkpointCount: number;
  checkpointText: string | null;
  active: boolean;
  synthesising: boolean;
  agents: readonly SwarmAgentLiveState[];
  settledCount: number;
  answer: string | null;
  answerState: string | null;
  synthesisSource: "model" | "model-repaired" | "fallback" | null;
  synthesisRecovery: "standard-after-pro" | null;
  followUps: readonly string[];
  error: string | null;
}>;

export type SwarmFleetAgent = Readonly<{
  key: string;
  title: string;
  tagline: string;
  role: string;
  prompt: string;
}>;

export type SwarmFleetPreferences = Readonly<{
  model: string;
  reasoningEffort: string;
  fastMode: boolean;
  solPlanner: boolean;
  proMode: boolean;
}>;

const EMPTY_SNAPSHOT: SwarmRunSnapshot = Object.freeze({
  runId: null,
  parentConversationId: null,
  parentTurnId: null,
  question: null,
  periodLabel: null,
  kind: "question",
  runtime: "codex",
  startedAtMs: null,
  durationMs: null,
  elapsedMs: 0,
  checkpointIntervalMs: null,
  checkpointCount: 0,
  checkpointText: null,
  active: false,
  synthesising: false,
  agents: Object.freeze([]),
  settledCount: 0,
  answer: null,
  answerState: null,
  synthesisSource: null,
  synthesisRecovery: null,
  followUps: Object.freeze([]),
  error: null,
});

let snapshot: SwarmRunSnapshot = EMPTY_SNAPSHOT;
let agentStates = new Map<string, SwarmAgentLiveState>();
let agentOrder: string[] = [];
let fleetActive = false;
let currentRunToken = 0;
let heartbeatTimer: number | undefined;
let checkpointTimer: number | undefined;
let deadlineTimer: number | undefined;
let superAgentDeadlineReached = false;
const listeners = new Set<() => void>();
const abortByAgent = new Map<string, AbortController>();
const waveFindings = new Map<string, SwarmWaveFinding>();

function publish(patch: Partial<SwarmRunSnapshot> = {}, settledDelta = 0): void {
  snapshot = Object.freeze({
    ...snapshot,
    ...patch,
    active: fleetActive || Boolean(patch.synthesising ?? snapshot.synthesising),
    agents: Object.freeze(agentOrder
      .map((key) => agentStates.get(key))
      .filter((state): state is SwarmAgentLiveState => Boolean(state))),
    settledCount: snapshot.settledCount + settledDelta,
  });
  for (const listener of listeners) listener();
}

export function subscribeSwarmRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function swarmRunSnapshot(): SwarmRunSnapshot {
  return snapshot;
}

function setAgent(
  key: string,
  patch: Partial<SwarmAgentLiveState>,
  settledDelta = 0,
): void {
  const current = agentStates.get(key);
  if (!current) return;
  agentStates.set(key, Object.freeze({ ...current, ...patch }));
  publish({}, settledDelta);
}

function totalQueriesSeen(): number {
  return [...agentStates.values()].reduce((total, agent) => total + agent.queriesSeen, 0);
}

function clearFleetTimers(): void {
  if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
  if (checkpointTimer !== undefined) window.clearInterval(checkpointTimer);
  if (deadlineTimer !== undefined) window.clearTimeout(deadlineTimer);
  heartbeatTimer = undefined;
  checkpointTimer = undefined;
  deadlineTimer = undefined;
}

export function formatSuperAgentCheckpoint(input: Readonly<{
  elapsedMs: number;
  completedPasses: number;
  totalPasses: number;
  queriesSeen: number;
  activePass?: string | null;
}>): string {
  const elapsedMinutes = Math.max(0, Math.floor(input.elapsedMs / 60_000));
  const pass = input.activePass?.trim()
    ? ` Current: ${input.activePass.trim()}.`
    : " Preparing the final synthesis.";
  return `${elapsedMinutes}m elapsed · ${input.completedPasses} of ${input.totalPasses} passes complete · ${input.queriesSeen} governed ${input.queriesSeen === 1 ? "query" : "queries"}.${pass}`;
}

function publishSuperAgentCheckpoint(runToken: number): void {
  if (runToken !== currentRunToken || snapshot.kind !== "super-agent" || !snapshot.startedAtMs) return;
  const elapsedMs = Math.min(
    snapshot.durationMs ?? Number.MAX_SAFE_INTEGER,
    Date.now() - snapshot.startedAtMs,
  );
  const completedPasses = [...agentStates.values()].filter((agent) => (
    agent.phase === "done" || agent.phase === "failed" || agent.phase === "stopped"
  )).length;
  const activePass = [...agentStates.values()].find((agent) => (
    agent.phase === "starting" || agent.phase === "researching" || agent.phase === "recording"
  ));
  publish({
    elapsedMs,
    checkpointCount: snapshot.checkpointCount + 1,
    checkpointText: formatSuperAgentCheckpoint({
      elapsedMs,
      completedPasses,
      totalPasses: agentStates.size,
      queriesSeen: totalQueriesSeen(),
      activePass: activePass?.title,
    }),
  });
}

type RecordedFinding = Readonly<{
  headline: string | null;
  answerState: string | null;
  keyNumbers: readonly Readonly<{ label: string; value: string }>[];
}>;

async function recordAgent(body: Record<string, unknown>): Promise<RecordedFinding | null> {
  // Transient failures retry: losing a lifecycle record strands the run row.
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch("/api/swarm/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      continue;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= 3) {
        throw new Error(payload?.error || `Recording failed (${response.status}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      continue;
    }
    const payload = await response.json().catch(() => null) as {
      agent?: { headline?: unknown; answerState?: unknown; keyNumbers?: unknown };
    } | null;
    const agent = payload?.agent;
    if (!agent) return null;
    return {
      headline: typeof agent.headline === "string" ? agent.headline : null,
      answerState: typeof agent.answerState === "string" ? agent.answerState : null,
      keyNumbers: Array.isArray(agent.keyNumbers)
        ? agent.keyNumbers
          .filter((item): item is { label: string; value: string } => (
            typeof item === "object" && item !== null
            && typeof (item as { label?: unknown }).label === "string"
            && typeof (item as { value?: unknown }).value === "string"
          ))
          .slice(0, 6)
        : [],
    };
  }
}

/**
 * Transport failures that sever the browser's view of a worker stream while
 * the child turn keeps running server-side. Covers the messages Chrome
 * ("network error", "Failed to fetch"), Safari ("Load failed", "The network
 * connection was lost.") and Firefox ("NetworkError…") actually throw.
 */
const TRANSIENT_STREAM_FAILURE =
  /could not be reached|network|failed to fetch|load failed|timed out|connection|premature close/iu;

const RECOVERY_POLL_INTERVAL_MS = 10_000;
const RECOVERY_POLL_ATTEMPTS = 24;

type RecoveredAgentFinding = Readonly<{
  headline: string | null;
  answerState: string | null;
  keyNumbers: readonly Readonly<{ label: string; value: string }>[];
}>;

type ChildRecoveryOutcome =
  | Readonly<{ kind: "recovered"; finding: RecoveredAgentFinding }>
  /** The child turn settled without an answer — a fresh attempt is safe. */
  | Readonly<{ kind: "dead" }>
  /** The child turn was still running when the poll budget (or run) ended —
   * re-POSTing now would duplicate a live analysis. */
  | Readonly<{ kind: "still-running" }>;

/**
 * Poll the persisted child turn for the answer a broken stream never
 * relayed. The child keeps executing server-side after a disconnect, so this
 * waits while the server reports the turn still running and gives up as soon
 * as the turn settles without an answer (or the poll budget ends).
 */
async function recoverAgentFinding(
  runToken: number,
  runId: string,
  agentKey: string,
  signal: AbortSignal,
): Promise<ChildRecoveryOutcome> {
  for (let poll = 0; poll < RECOVERY_POLL_ATTEMPTS; poll += 1) {
    if (signal.aborted || runToken !== currentRunToken) return { kind: "still-running" };
    try {
      const response = await fetch("/api/swarm/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recover", runId, agentKey }),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null) as {
          recovered?: boolean;
          pending?: boolean;
          agent?: { headline?: unknown; answerState?: unknown; keyNumbers?: unknown };
        } | null;
        if (payload?.recovered && payload.agent) {
          return {
            kind: "recovered",
            finding: {
              headline: typeof payload.agent.headline === "string" ? payload.agent.headline : null,
              answerState: typeof payload.agent.answerState === "string" ? payload.agent.answerState : null,
              keyNumbers: Array.isArray(payload.agent.keyNumbers)
                ? payload.agent.keyNumbers
                  .filter((item): item is { label: string; value: string } => (
                    typeof item === "object" && item !== null
                    && typeof (item as { label?: unknown }).label === "string"
                    && typeof (item as { value?: unknown }).value === "string"
                  ))
                  .slice(0, 6)
                : [],
            },
          };
        }
        if (payload && payload.pending !== true) return { kind: "dead" };
      }
    } catch {
      // The same drop that broke the stream can break a poll; the next
      // attempt answers either way.
    }
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_POLL_INTERVAL_MS));
  }
  return { kind: "still-running" };
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

type AgentOutcome = Readonly<{
  answer: string;
  answerState: string;
  followUps: readonly string[];
}>;

async function runAgent(
  runToken: number,
  runId: string,
  agent: SwarmFleetAgent,
  preferences: SwarmFleetPreferences,
  attempt = 0,
): Promise<void> {
  const controller = new AbortController();
  abortByAgent.set(agent.key, controller);
  setAgent(agent.key, { phase: "starting", statusLine: "Contacting Albert…" });
  // The run's harness decides where workers execute. Omni's request schema is
  // strict and has no Codex-only reasoning switches, so those fields are
  // never sent on the omni path.
  const workerEndpoint = snapshot.runtime === "omni"
    ? "/api/omni-conversation"
    : "/api/codex-conversation";
  try {
    let response: Response | null = null;
    for (let attempt = 0; ; attempt += 1) {
      if (runToken !== currentRunToken) return;
      response = await fetch(workerEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: agent.prompt,
          preferences: {
            model: preferences.model,
            reasoningEffort: preferences.reasoningEffort,
            fastMode: preferences.fastMode,
          },
          ...(snapshot.runtime !== "omni" && preferences.solPlanner ? { solPlanner: true } : {}),
          ...(snapshot.runtime !== "omni" && preferences.proMode ? { proMode: true } : {}),
        }),
        signal: controller.signal,
      });
      if (response.ok || attempt >= 8) break;
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      const message = payload?.error || `The analysis could not be started (${response.status}).`;
      const atCapacity = response.status === 429
        || response.status === 503
        || /at capacity|rate limit|try again/iu.test(message);
      if (!atCapacity || runToken !== currentRunToken) throw new Error(message);
      setAgent(agent.key, {
        statusLine: `Albert is at capacity, retrying in 45s (attempt ${attempt + 1})`,
      });
      await new Promise((resolve) => setTimeout(resolve, 45_000));
    }
    if (!response || !response.ok || !response.body) {
      const payload = response
        ? await response.json().catch(() => null) as { error?: string } | null
        : null;
      throw new Error(payload?.error || "The analysis could not be started.");
    }
    const conversationId = response.headers.get("X-Albert-Conversation-Id");
    const turnId = response.headers.get("X-Albert-Turn-Id");
    if (!conversationId || !turnId) {
      response.body.cancel("missing conversation identity").catch(() => undefined);
      throw new Error("The analysis stream did not identify its conversation.");
    }
    setAgent(agent.key, {
      phase: "researching",
      statusLine: "Reading the connected data…",
      conversationId,
      turnId,
    });
    await recordAgent({
      action: "started",
      runId,
      agentKey: agent.key,
      conversationId,
      turnId,
    }).catch(() => undefined);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome: AgentOutcome | null = null;
    let streamError: string | null = null;
    let queriesSeen = 0;
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
        if (event.type === "progress" && typeof event.label === "string") {
          setAgent(agent.key, { statusLine: event.label.slice(0, 160) });
        } else if (event.type === "narrative" && typeof event.text === "string" && event.purpose === "reasoning_summary") {
          // Feed the Reasoning panel: each child streams provider reasoning
          // summaries on its own conversation, invisible to the parent trace.
          setAgent(agent.key, { reasoningSummary: event.text.slice(0, 2_000) });
        } else if (event.type === "narrative" && typeof event.text === "string" && event.purpose !== "acknowledgement") {
          setAgent(agent.key, { statusLine: event.text.slice(0, 160) });
        } else if (event.type === "query") {
          queriesSeen += 1;
          setAgent(agent.key, {
            queriesSeen,
            statusLine: typeof event.topic === "string"
              ? `Querying ${event.topic.slice(0, 140)}…`
              : `Running query ${queriesSeen}…`,
          });
        } else if (event.type === "answer" && typeof event.text === "string" && typeof event.state === "string") {
          outcome = {
            answer: event.text,
            answerState: event.state,
            followUps: Array.isArray(event.followUps)
              ? event.followUps.filter((item): item is string => typeof item === "string").slice(0, 6)
              : [],
          };
        } else if (event.type === "error" && typeof event.message === "string") {
          streamError = event.message;
        }
      }
      if (done) break;
    }

    if (!outcome) {
      throw new Error(streamError || "The analysis ended before an answer arrived.");
    }
    setAgent(agent.key, { phase: "recording", statusLine: "Recording the finding…" });
    // A failed record must not overwrite a successful analysis: the child
    // turn has already persisted this answer on its own conversation, and
    // synthesis re-reads it server-side by the stored turn id.
    let recorded: RecordedFinding | null = null;
    try {
      recorded = await recordAgent({
        action: "completed",
        runId,
        agentKey: agent.key,
        answerState: outcome.answerState,
        answer: outcome.answer.slice(0, 8_000),
        followUps: outcome.followUps.map((question) => question.slice(0, 200)),
      });
    } catch {
      recorded = null;
    }
    const headline = recorded?.headline
      ?? outcome.answer.split("\n").find((line) => line.trim())?.replace(/^#+\s*/u, "").slice(0, 200)
      ?? null;
    waveFindings.set(agent.key, {
      title: agent.title,
      headline,
      answerState: recorded?.answerState ?? outcome.answerState,
      keyNumbers: recorded?.keyNumbers ?? [],
      failed: false,
    });
    if (runToken !== currentRunToken) return;
    setAgent(agent.key, {
      phase: "done",
      statusLine: "Done",
      answerState: outcome.answerState,
      headline,
    }, 1);
  } catch (error) {
    const settleInterrupted = async (): Promise<void> => {
      if (runToken === currentRunToken && superAgentDeadlineReached) {
        const failureNote = "The 45-minute Super agent budget ended during this pass.";
        await recordAgent({
          action: "failed",
          runId,
          agentKey: agent.key,
          failureNote,
        }).catch(() => undefined);
        waveFindings.set(agent.key, {
          title: agent.title,
          headline: null,
          answerState: null,
          keyNumbers: [],
          failed: true,
        });
        setAgent(agent.key, { phase: "failed", statusLine: "45-minute budget reached", error: failureNote }, 1);
      } else {
        setAgent(agent.key, { phase: "stopped", statusLine: "Stopped" }, 1);
      }
    };
    if (controller.signal.aborted || runToken !== currentRunToken) {
      await settleInterrupted();
      return;
    }
    const message = error instanceof Error ? error.message.slice(0, 280) : "The analysis failed.";
    const transientStream = TRANSIENT_STREAM_FAILURE.test(message);
    const liveState = agentStates.get(agent.key);
    const hasChildTurn = Boolean(liveState?.conversationId && liveState?.turnId);
    // A severed stream does not mean the child died: the server keeps
    // executing after a disconnect and persists the answer on the child's
    // conversation. Recover that answer instead of recording a false failure
    // (and instead of re-POSTing a duplicate of a still-running analysis).
    let childOutcome: ChildRecoveryOutcome | null = null;
    if (transientStream && hasChildTurn) {
      setAgent(agent.key, {
        phase: "recording",
        statusLine: "Connection dropped — recovering the analysis…",
        error: null,
      });
      childOutcome = await recoverAgentFinding(runToken, runId, agent.key, controller.signal);
      if (controller.signal.aborted || runToken !== currentRunToken) {
        await settleInterrupted();
        return;
      }
      if (childOutcome.kind === "recovered") {
        const finding = childOutcome.finding;
        waveFindings.set(agent.key, {
          title: agent.title,
          headline: finding.headline,
          answerState: finding.answerState,
          keyNumbers: finding.keyNumbers,
          failed: false,
        });
        setAgent(agent.key, {
          phase: "done",
          statusLine: "Done",
          answerState: finding.answerState,
          headline: finding.headline,
          error: null,
        }, 1);
        return;
      }
    }
    const retryable = transientStream && childOutcome?.kind !== "still-running";
    if (retryable && attempt < 2 && runToken === currentRunToken) {
      setAgent(agent.key, {
        phase: "starting",
        statusLine: `The analysis dropped, retrying (attempt ${attempt + 2})…`,
        error: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      if (runToken !== currentRunToken) return;
      return runAgent(runToken, runId, agent, preferences, attempt + 1);
    }
    await recordAgent({
      action: "failed",
      runId,
      agentKey: agent.key,
      failureNote: message,
    }).catch(() => undefined);
    waveFindings.set(agent.key, {
      title: agent.title,
      headline: null,
      answerState: null,
      keyNumbers: [],
      failed: true,
    });
    setAgent(agent.key, { phase: "failed", statusLine: "Failed", error: message }, 1);
  } finally {
    abortByAgent.delete(agent.key);
  }
}

async function synthesise(runToken: number, runId: string): Promise<void> {
  if (runToken !== currentRunToken) return;
  publish({ synthesising: true });
  try {
    const response = await fetch("/api/swarm/synthesis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const payload = await response.json().catch(() => null) as {
      error?: string;
      synthesis?: {
        answer?: string;
        answerState?: string;
        source?: "model" | "model-repaired" | "fallback";
        recovery?: "standard-after-pro" | null;
        followUps?: string[];
      };
    } | null;
    if (!response.ok || !payload?.synthesis?.answer) {
      throw new Error(payload?.error || "The combined answer could not be written.");
    }
    if (runToken !== currentRunToken) return;
    publish({
      synthesising: false,
      active: false,
      answer: payload.synthesis.answer,
      answerState: payload.synthesis.answerState ?? "Derived",
      synthesisSource: payload.synthesis.source ?? null,
      synthesisRecovery: payload.synthesis.recovery ?? null,
      followUps: Object.freeze(payload.synthesis.followUps ?? []),
    });
  } catch (error) {
    if (runToken !== currentRunToken) return;
    publish({
      synthesising: false,
      active: false,
      error: error instanceof Error ? error.message : "The combined answer could not be written.",
    });
  }
}

function startHeartbeat(runId: string, runToken: number): void {
  if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    if (runToken !== currentRunToken) return;
    void fetch("/api/swarm/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    }).catch(() => undefined);
  }, 90_000);
}

function startSuperAgentTimers(input: Readonly<{
  runToken: number;
  durationMs: number;
  checkpointIntervalMs: number;
}>): void {
  checkpointTimer = window.setInterval(() => {
    publishSuperAgentCheckpoint(input.runToken);
  }, input.checkpointIntervalMs);
  deadlineTimer = window.setTimeout(() => {
    if (input.runToken !== currentRunToken) return;
    superAgentDeadlineReached = true;
    publishSuperAgentCheckpoint(input.runToken);
    abortByAgent.forEach((controller) => controller.abort("super-agent-deadline"));
  }, input.durationMs);
}

async function recordUnfinishedSuperAgentPasses(runId: string): Promise<void> {
  for (const agent of agentStates.values()) {
    if (agent.phase !== "pending") continue;
    const failureNote = "This pass did not start before the 45-minute Super agent budget ended.";
    await recordAgent({
      action: "failed",
      runId,
      agentKey: agent.key,
      failureNote,
    }).catch(() => undefined);
    waveFindings.set(agent.key, {
      title: agent.title,
      headline: null,
      answerState: null,
      keyNumbers: [],
      failed: true,
    });
    setAgent(agent.key, {
      phase: "failed",
      statusLine: "Not started before the 45-minute limit",
      error: failureNote,
    }, 1);
  }
}

async function runWave(
  runToken: number,
  runId: string,
  agents: readonly SwarmFleetAgent[],
  preferences: SwarmFleetPreferences,
  concurrency: number,
): Promise<void> {
  if (agents.length === 0) return;
  const queue = [...agents];
  const worker = async () => {
    for (;;) {
      const agent = queue.shift();
      if (!agent || runToken !== currentRunToken || superAgentDeadlineReached) break;
      await runAgent(runToken, runId, agent, preferences);
    }
  };
  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(concurrency, agents.length)) },
    () => worker(),
  ));
}

async function runSuperAgentPasses(
  runToken: number,
  runId: string,
  agents: readonly SwarmFleetAgent[],
  preferences: SwarmFleetPreferences,
): Promise<void> {
  for (const agent of agents) {
    if (runToken !== currentRunToken || superAgentDeadlineReached) return;
    const priorFindings = [...waveFindings.values()];
    const briefed = priorFindings.length > 0
      ? {
          ...agent,
          prompt: appendSwarmBrief(agent.prompt, buildSwarmWaveBrief(priorFindings)),
        }
      : agent;
    await runAgent(runToken, runId, briefed, preferences);
  }
}

export function startSwarmFleet(input: Readonly<{
  runId: string;
  parentConversationId: string;
  parentTurnId: string;
  question: string;
  periodLabel: string;
  agents: readonly SwarmFleetAgent[];
  preferences: SwarmFleetPreferences;
  concurrency: number;
  kind?: SwarmRunKind;
  runtime?: SwarmRunRuntime;
  durationMs?: number;
  checkpointIntervalMs?: number;
}>): void {
  currentRunToken += 1;
  const runToken = currentRunToken;
  agentStates = new Map();
  agentOrder = [];
  waveFindings.clear();
  abortByAgent.forEach((controller) => controller.abort());
  abortByAgent.clear();
  clearFleetTimers();
  superAgentDeadlineReached = false;
  const { firstWave, secondWave } = splitSwarmWaves(input.agents);
  const secondWaveKeys = new Set(secondWave.map((agent) => agent.key));
  for (const agent of input.agents) {
    agentOrder.push(agent.key);
    agentStates.set(agent.key, Object.freeze({
      key: agent.key,
      title: agent.title,
      tagline: agent.tagline,
      role: agent.role,
      phase: "pending" as const,
      statusLine: input.kind === "super-agent"
        ? "Waiting for the previous pass"
        : secondWaveKeys.has(agent.key) ? "Waiting on the first wave" : "Queued",
      queriesSeen: 0,
      headline: null,
      answerState: null,
      conversationId: null,
      turnId: null,
      error: null,
    }));
  }
  fleetActive = true;
  const startedAtMs = Date.now();
  snapshot = Object.freeze({
    ...EMPTY_SNAPSHOT,
    runId: input.runId,
    parentConversationId: input.parentConversationId,
    parentTurnId: input.parentTurnId,
    question: input.question,
    periodLabel: input.periodLabel,
    kind: input.kind ?? "question",
    runtime: input.runtime ?? "codex",
    startedAtMs,
    durationMs: input.durationMs ?? null,
    checkpointIntervalMs: input.checkpointIntervalMs ?? null,
    active: true,
  });
  publish();
  startHeartbeat(input.runId, runToken);
  if (input.kind === "super-agent" && input.durationMs && input.checkpointIntervalMs) {
    startSuperAgentTimers({
      runToken,
      durationMs: input.durationMs,
      checkpointIntervalMs: input.checkpointIntervalMs,
    });
  }
  void (async () => {
    if (input.kind === "super-agent") {
      await runSuperAgentPasses(runToken, input.runId, input.agents, input.preferences);
      if (runToken !== currentRunToken) return;
    } else {
      await runWave(runToken, input.runId, firstWave, input.preferences, input.concurrency);
      if (runToken !== currentRunToken) return;
      if (secondWave.length > 0) {
        const brief = buildSwarmWaveBrief(firstWave
          .map((agent) => waveFindings.get(agent.key))
          .filter((finding): finding is SwarmWaveFinding => Boolean(finding)));
        const briefed = secondWave.map((agent) => ({
          ...agent,
          prompt: appendSwarmBrief(agent.prompt, brief),
        }));
        await runWave(runToken, input.runId, briefed, input.preferences, input.concurrency);
        if (runToken !== currentRunToken) return;
      }
    }
    if (input.kind === "super-agent" && superAgentDeadlineReached) {
      await recordUnfinishedSuperAgentPasses(input.runId);
    }
    fleetActive = false;
    if (input.kind === "super-agent") publishSuperAgentCheckpoint(runToken);
    // The heartbeat keeps renewing the parent turn lease until synthesis has
    // finished: a Pro synthesis can outlive the 360-second lease, and an
    // expired lease mid-synthesis reads as a stranded run to reconciliation.
    if (checkpointTimer !== undefined) {
      window.clearInterval(checkpointTimer);
      checkpointTimer = undefined;
    }
    if (deadlineTimer !== undefined) {
      window.clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    await synthesise(runToken, input.runId);
    if (runToken === currentRunToken) clearFleetTimers();
  })();
}

export function stopSwarmFleet(): void {
  const runId = snapshot.runId;
  currentRunToken += 1;
  abortByAgent.forEach((controller) => controller.abort());
  abortByAgent.clear();
  fleetActive = false;
  superAgentDeadlineReached = false;
  clearFleetTimers();
  for (const key of agentOrder) {
    const current = agentStates.get(key);
    if (!current || current.phase === "done" || current.phase === "failed") continue;
    agentStates.set(key, Object.freeze({
      ...current,
      phase: "stopped",
      statusLine: "Stopped",
    }));
  }
  publish({ active: false, synthesising: false });
  if (runId) {
    void fetch("/api/swarm/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    }).catch(() => undefined);
  }
}

export function hydrateSwarmFromRun(input: Readonly<{
  runId: string;
  parentConversationId: string;
  parentTurnId: string;
  question: string;
  periodLabel: string;
  agents: readonly SwarmAgentLiveState[];
  answer: string | null;
  answerState: string | null;
  synthesisSource?: "model" | "model-repaired" | "fallback" | null;
  synthesisRecovery?: "standard-after-pro" | null;
  followUps?: readonly string[];
  kind?: SwarmRunKind;
  runtime?: SwarmRunRuntime;
  startedAt?: string;
  durationMs?: number;
  checkpointIntervalMs?: number;
}>): void {
  // A live fleet's module state is fresher than any persisted row, and agent
  // keys are formulaic across runs — hydrating over it would splice one run's
  // agents into another. The live orchestrator owns the store until it
  // settles (defect: cross-run state bleed).
  if ((fleetActive || snapshot.synthesising) && snapshot.runId !== null) return;
  agentStates = new Map();
  agentOrder = input.agents.map((agent) => agent.key);
  for (const agent of input.agents) {
    agentStates.set(agent.key, Object.freeze(agent));
  }
  const stillOpen = input.agents.some((agent) => (
    agent.phase === "pending"
    || agent.phase === "starting"
    || agent.phase === "researching"
    || agent.phase === "recording"
  ));
  const startedAtMs = input.startedAt ? new Date(input.startedAt).valueOf() : null;
  snapshot = Object.freeze({
    ...EMPTY_SNAPSHOT,
    runId: input.runId,
    parentConversationId: input.parentConversationId,
    parentTurnId: input.parentTurnId,
    question: input.question,
    periodLabel: input.periodLabel,
    kind: input.kind ?? "question",
    runtime: input.runtime ?? "codex",
    startedAtMs: startedAtMs !== null && Number.isFinite(startedAtMs) ? startedAtMs : null,
    durationMs: input.durationMs ?? null,
    elapsedMs: startedAtMs !== null && Number.isFinite(startedAtMs)
      ? Math.max(0, Math.min(input.durationMs ?? Number.MAX_SAFE_INTEGER, Date.now() - startedAtMs))
      : 0,
    checkpointIntervalMs: input.checkpointIntervalMs ?? null,
    agents: Object.freeze([...input.agents]),
    answer: input.answer,
    answerState: input.answerState,
    synthesisSource: input.synthesisSource ?? null,
    synthesisRecovery: input.synthesisRecovery ?? null,
    followUps: Object.freeze([...(input.followUps ?? [])]),
    active: stillOpen && !input.answer,
  });
  for (const listener of listeners) listener();
}
