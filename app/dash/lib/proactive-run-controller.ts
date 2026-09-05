/**
 * Client orchestrator for a Proactive research run (ADR 0113).
 *
 * Lives at module scope, outside React, so switching dash tabs never aborts
 * the fleet: each agent is one POST to /api/codex-conversation whose SSE
 * stream is read to the terminal answer, then the distilled finding is
 * recorded through /api/proactive/finding. The workspace subscribes with
 * useSyncExternalStore. One run at a time per browser tab; starting a new run
 * replaces the tracked state (the server abandons the previous run row).
 */

export type ProactiveAgentPhase =
  | "pending"
  | "starting"
  | "researching"
  | "recording"
  | "done"
  | "failed";

export type ProactiveAgentLiveState = Readonly<{
  key: string;
  title: string;
  tagline: string;
  phase: ProactiveAgentPhase;
  /** The latest human-readable line of what the agent is doing. */
  statusLine: string;
  queriesSeen: number;
  headline: string | null;
  answerState: string | null;
  conversationId: string | null;
  error: string | null;
}>;

export type ProactiveRunSnapshot = Readonly<{
  runId: string | null;
  /** True while any agent fetch is still in flight. */
  active: boolean;
  agents: readonly ProactiveAgentLiveState[];
  /** Bumped on every settled agent so the workspace refetches the panel. */
  settledCount: number;
}>;

export type ProactiveFleetAgent = Readonly<{
  key: string;
  title: string;
  tagline: string;
  prompt: string;
}>;

export type ProactiveFleetPreferences = Readonly<{
  model: string;
  reasoningEffort: string;
  fastMode: boolean;
}>;

const EMPTY_SNAPSHOT: ProactiveRunSnapshot = Object.freeze({
  runId: null,
  active: false,
  agents: Object.freeze([]),
  settledCount: 0,
});

let snapshot: ProactiveRunSnapshot = EMPTY_SNAPSHOT;
let agentStates = new Map<string, ProactiveAgentLiveState>();
let agentOrder: string[] = [];
let inFlight = 0;
let currentRunToken = 0;
const listeners = new Set<() => void>();

function publish(runId: string | null, settledDelta = 0): void {
  snapshot = Object.freeze({
    runId,
    active: inFlight > 0,
    agents: Object.freeze(agentOrder
      .map((key) => agentStates.get(key))
      .filter((state): state is ProactiveAgentLiveState => Boolean(state))),
    settledCount: snapshot.settledCount + settledDelta,
  });
  for (const listener of listeners) listener();
}

export function subscribeProactiveRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function proactiveRunSnapshot(): ProactiveRunSnapshot {
  return snapshot;
}

function setAgent(
  runId: string,
  key: string,
  patch: Partial<ProactiveAgentLiveState>,
  settledDelta = 0,
): void {
  const current = agentStates.get(key);
  if (!current) return;
  agentStates.set(key, Object.freeze({ ...current, ...patch }));
  publish(runId, settledDelta);
}

async function recordFinding(body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/proactive/finding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Recording failed (${response.status}).`);
  }
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
  agent: ProactiveFleetAgent,
  preferences: ProactiveFleetPreferences,
): Promise<void> {
  setAgent(runId, agent.key, { phase: "starting", statusLine: "Contacting Albert…" });
  try {
    // The codex runtime admits a bounded number of concurrent turns; when it
    // is at capacity (shared with interactive chat), wait and retry instead of
    // failing the agent.
    let response: Response | null = null;
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch("/api/codex-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: agent.prompt, preferences }),
      });
      if (response.ok || attempt >= 8) break;
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      const message = payload?.error || `The analysis could not be started (${response.status}).`;
      const atCapacity = response.status === 429
        || response.status === 503
        || /at capacity|rate limit|try again/iu.test(message);
      if (!atCapacity || runToken !== currentRunToken) throw new Error(message);
      setAgent(runId, agent.key, {
        statusLine: `Albert is at capacity — retrying in 45s (attempt ${attempt + 1})`,
      });
      await new Promise((resolve) => setTimeout(resolve, 45_000));
      if (runToken !== currentRunToken) return;
    }
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || `The analysis could not be started (${response.status}).`);
    }
    const conversationId = response.headers.get("X-Albert-Conversation-Id");
    const turnId = response.headers.get("X-Albert-Turn-Id");
    if (!conversationId || !turnId) {
      response.body.cancel("missing conversation identity").catch(() => undefined);
      throw new Error("The analysis stream did not identify its conversation.");
    }
    setAgent(runId, agent.key, {
      phase: "researching",
      statusLine: "Reading the connected data…",
      conversationId,
    });
    await recordFinding({
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
          setAgent(runId, agent.key, { statusLine: event.label.slice(0, 160) });
        } else if (event.type === "narrative" && typeof event.text === "string" && event.purpose !== "acknowledgement") {
          setAgent(runId, agent.key, { statusLine: event.text.slice(0, 160) });
        } else if (event.type === "query") {
          queriesSeen += 1;
          setAgent(runId, agent.key, {
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
    setAgent(runId, agent.key, { phase: "recording", statusLine: "Recording the finding…" });
    await recordFinding({
      action: "completed",
      runId,
      agentKey: agent.key,
      answerState: outcome.answerState,
      answer: outcome.answer.slice(0, 8_000),
      followUps: outcome.followUps.map((question) => question.slice(0, 200)),
    });
    if (runToken !== currentRunToken) return;
    setAgent(runId, agent.key, {
      phase: "done",
      statusLine: "Done",
      answerState: outcome.answerState,
      headline: outcome.answer.split("\n").find((line) => line.trim())?.replace(/^#+\s*/u, "").slice(0, 200) ?? null,
    }, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 280) : "The analysis failed.";
    await recordFinding({
      action: "failed",
      runId,
      agentKey: agent.key,
      failureNote: message,
    }).catch(() => undefined);
    if (runToken !== currentRunToken) return;
    setAgent(runId, agent.key, { phase: "failed", statusLine: "Failed", error: message }, 1);
  }
}

/**
 * Fan the fleet out with bounded concurrency. Existing tracked state is
 * replaced; agents already listed keep their identity so a resume run can
 * re-launch only the incomplete subset.
 */
export function startProactiveFleet(input: Readonly<{
  runId: string;
  agents: readonly ProactiveFleetAgent[];
  preferences: ProactiveFleetPreferences;
  concurrency: number;
  /** Agents shown as already settled (a resumed run's completed findings). */
  alreadySettled?: readonly Readonly<{ key: string; title: string; tagline: string; headline: string | null; phase: "done" | "failed" }>[];
}>): void {
  currentRunToken += 1;
  const runToken = currentRunToken;
  agentStates = new Map();
  agentOrder = [];
  for (const settled of input.alreadySettled ?? []) {
    agentOrder.push(settled.key);
    agentStates.set(settled.key, Object.freeze({
      key: settled.key,
      title: settled.title,
      tagline: settled.tagline,
      phase: settled.phase,
      statusLine: settled.phase === "done" ? "Done" : "Failed",
      queriesSeen: 0,
      headline: settled.headline,
      answerState: null,
      conversationId: null,
      error: null,
    }));
  }
  for (const agent of input.agents) {
    agentOrder.push(agent.key);
    agentStates.set(agent.key, Object.freeze({
      key: agent.key,
      title: agent.title,
      tagline: agent.tagline,
      phase: "pending" as const,
      statusLine: "Queued",
      queriesSeen: 0,
      headline: null,
      answerState: null,
      conversationId: null,
      error: null,
    }));
  }
  snapshot = Object.freeze({ runId: input.runId, active: true, agents: [], settledCount: 0 });
  publish(input.runId);

  const queue = [...input.agents];
  const width = Math.max(1, Math.min(input.concurrency, queue.length));
  inFlight = 0;
  const worker = async () => {
    for (;;) {
      const agent = queue.shift();
      if (!agent || runToken !== currentRunToken) break;
      await runAgent(runToken, input.runId, agent, input.preferences);
    }
  };
  for (let index = 0; index < width; index += 1) {
    inFlight += 1;
    void worker().finally(() => {
      inFlight -= 1;
      if (runToken === currentRunToken) publish(input.runId);
    });
  }
  publish(input.runId);
}
