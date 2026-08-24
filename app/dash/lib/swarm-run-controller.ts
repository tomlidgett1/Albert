/**
 * Client orchestrator for a Codex Swarm run (ADR 0120).
 *
 * Lives at module scope so switching dash tabs never aborts the fleet.
 * Each agent is one POST to /api/codex-conversation. When every agent
 * settles, the controller asks /api/swarm/synthesis to write the parent
 * answer.
 */

export type SwarmAgentPhase =
  | "pending"
  | "starting"
  | "researching"
  | "recording"
  | "done"
  | "failed"
  | "stopped";

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
}>;

export type SwarmRunSnapshot = Readonly<{
  runId: string | null;
  parentConversationId: string | null;
  parentTurnId: string | null;
  question: string | null;
  periodLabel: string | null;
  active: boolean;
  synthesising: boolean;
  agents: readonly SwarmAgentLiveState[];
  settledCount: number;
  answer: string | null;
  answerState: string | null;
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
}>;

const EMPTY_SNAPSHOT: SwarmRunSnapshot = Object.freeze({
  runId: null,
  parentConversationId: null,
  parentTurnId: null,
  question: null,
  periodLabel: null,
  active: false,
  synthesising: false,
  agents: Object.freeze([]),
  settledCount: 0,
  answer: null,
  answerState: null,
  followUps: Object.freeze([]),
  error: null,
});

let snapshot: SwarmRunSnapshot = EMPTY_SNAPSHOT;
let agentStates = new Map<string, SwarmAgentLiveState>();
let agentOrder: string[] = [];
let inFlight = 0;
let currentRunToken = 0;
let heartbeatTimer: number | undefined;
const listeners = new Set<() => void>();
const abortByAgent = new Map<string, AbortController>();

function publish(patch: Partial<SwarmRunSnapshot> = {}, settledDelta = 0): void {
  snapshot = Object.freeze({
    ...snapshot,
    ...patch,
    active: inFlight > 0 || Boolean(patch.synthesising ?? snapshot.synthesising),
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

async function recordAgent(body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/swarm/agent", {
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
  agent: SwarmFleetAgent,
  preferences: SwarmFleetPreferences,
  attempt = 0,
): Promise<void> {
  const controller = new AbortController();
  abortByAgent.set(agent.key, controller);
  setAgent(agent.key, { phase: "starting", statusLine: "Contacting Albert…" });
  try {
    let response: Response | null = null;
    for (let attempt = 0; ; attempt += 1) {
      if (runToken !== currentRunToken) return;
      response = await fetch("/api/codex-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: agent.prompt, preferences }),
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
    await recordAgent({
      action: "completed",
      runId,
      agentKey: agent.key,
      answerState: outcome.answerState,
      answer: outcome.answer.slice(0, 8_000),
      followUps: outcome.followUps.map((question) => question.slice(0, 200)),
    });
    if (runToken !== currentRunToken) return;
    setAgent(agent.key, {
      phase: "done",
      statusLine: "Done",
      answerState: outcome.answerState,
      headline: outcome.answer.split("\n").find((line) => line.trim())?.replace(/^#+\s*/u, "").slice(0, 200) ?? null,
    }, 1);
  } catch (error) {
    if (controller.signal.aborted || runToken !== currentRunToken) {
      setAgent(agent.key, { phase: "stopped", statusLine: "Stopped" }, 1);
      return;
    }
    const message = error instanceof Error ? error.message.slice(0, 280) : "The analysis failed.";
    const retryable = /could not be reached|network connection lost|timed out/iu.test(message);
    if (retryable && attempt < 2 && runToken === currentRunToken) {
      setAgent(agent.key, {
        phase: "starting",
        statusLine: `Codex dropped, retrying (attempt ${attempt + 2})…`,
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

export function startSwarmFleet(input: Readonly<{
  runId: string;
  parentConversationId: string;
  parentTurnId: string;
  question: string;
  periodLabel: string;
  agents: readonly SwarmFleetAgent[];
  preferences: SwarmFleetPreferences;
  concurrency: number;
}>): void {
  currentRunToken += 1;
  const runToken = currentRunToken;
  agentStates = new Map();
  agentOrder = [];
  abortByAgent.forEach((controller) => controller.abort());
  abortByAgent.clear();
  for (const agent of input.agents) {
    agentOrder.push(agent.key);
    agentStates.set(agent.key, Object.freeze({
      key: agent.key,
      title: agent.title,
      tagline: agent.tagline,
      role: agent.role,
      phase: "pending" as const,
      statusLine: "Queued",
      queriesSeen: 0,
      headline: null,
      answerState: null,
      conversationId: null,
      turnId: null,
      error: null,
    }));
  }
  const queue = [...input.agents];
  const width = Math.max(1, Math.min(input.concurrency, queue.length));
  inFlight = width;
  snapshot = Object.freeze({
    ...EMPTY_SNAPSHOT,
    runId: input.runId,
    parentConversationId: input.parentConversationId,
    parentTurnId: input.parentTurnId,
    question: input.question,
    periodLabel: input.periodLabel,
    active: true,
  });
  publish();
  startHeartbeat(input.runId, runToken);
  const worker = async () => {
    for (;;) {
      const agent = queue.shift();
      if (!agent || runToken !== currentRunToken) break;
      await runAgent(runToken, input.runId, agent, input.preferences);
    }
  };
  const finished = Array.from({ length: width }, () => (
    worker().finally(() => {
      inFlight -= 1;
      if (runToken === currentRunToken) publish();
    })
  ));
  void Promise.all(finished).then(() => {
    if (runToken !== currentRunToken) return;
    if (heartbeatTimer !== undefined) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    return synthesise(runToken, input.runId);
  });
}

export function stopSwarmFleet(): void {
  const runId = snapshot.runId;
  currentRunToken += 1;
  abortByAgent.forEach((controller) => controller.abort());
  abortByAgent.clear();
  inFlight = 0;
  if (heartbeatTimer !== undefined) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
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
  followUps?: readonly string[];
}>): void {
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
  snapshot = Object.freeze({
    ...EMPTY_SNAPSHOT,
    runId: input.runId,
    parentConversationId: input.parentConversationId,
    parentTurnId: input.parentTurnId,
    question: input.question,
    periodLabel: input.periodLabel,
    agents: Object.freeze([...input.agents]),
    answer: input.answer,
    answerState: input.answerState,
    followUps: Object.freeze([...(input.followUps ?? [])]),
    active: stillOpen && !input.answer,
  });
  for (const listener of listeners) listener();
}
