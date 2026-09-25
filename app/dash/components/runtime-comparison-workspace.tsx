"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  albertModelById,
  type AgentRunPreferences,
  type AlbertModelId,
  type ReasoningEffort,
  type TraceEvent,
} from "@/packages/shared/src";
import InsightsStyleTrace from "./InsightsStyleTrace";
import OmniTrace from "./OmniTrace";
import { HarnessSelector } from "./HarnessSelector";
import { ModelRunControls } from "./ModelRunControls";
import styles from "../dash.module.css";

/** The analytical runtimes a conversation can run on. Omni is the product default. */
export type ConversationRuntimeTab = "albert" | "codex" | "omni" | "oai_codex" | "compare";

/** A runtime that can occupy one side of the split view. */
export type ComparePaneRuntime = Exclude<ConversationRuntimeTab, "compare">;

export type ComparePair = readonly [ComparePaneRuntime, ComparePaneRuntime];

/** The split view the harness selector opens: Omni against OAI Codex (ADR 0141). */
export const HARNESS_COMPARE_PAIR: ComparePair = ["omni", "oai_codex"];
/** The original engine comparison, still reachable through `?runtime=compare`. */
export const ENGINE_COMPARE_PAIR: ComparePair = ["albert", "codex"];

const COMPARE_DEFAULT_PREFERENCES: AgentRunPreferences = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  fastMode: true,
});
const COMPARE_MODEL_IDS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const satisfies readonly AlbertModelId[]);
const COMPARE_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningEffort[]);

type PaneRuntimeProfile = Readonly<{
  label: string;
  subtitle: string;
  mark: string;
  endpoint: string;
  /** The `X-Albert-Runtime` value the route must answer with. */
  runtimeHeader: string;
  trace: "insights" | "omni";
  /** Engine panes share a frozen analytical brief; harness panes share the governed tool set. */
  sharesBrief: boolean;
  body: (message: string, preferences: AgentRunPreferences) => Record<string, unknown>;
}>;

const PANE_PROFILES: Readonly<Record<ComparePaneRuntime, PaneRuntimeProfile>> = Object.freeze({
  albert: {
    label: "Albert",
    subtitle: "Albert V3",
    mark: "A",
    endpoint: "/api/v3-conversation",
    runtimeHeader: "v3",
    trace: "insights",
    sharesBrief: true,
    body: (message, preferences) => ({ message, preferences, specialistAgentId: "general", comparisonMode: true }),
  },
  codex: {
    label: "Codex",
    subtitle: "Codex app-server",
    mark: "C",
    endpoint: "/api/codex-conversation",
    runtimeHeader: "codex",
    trace: "insights",
    sharesBrief: true,
    body: (message, preferences) => ({ message, preferences, comparisonMode: true }),
  },
  omni: {
    label: "Omni",
    subtitle: "In-process agent loop",
    mark: "O",
    endpoint: "/api/omni-conversation",
    runtimeHeader: "omni",
    trace: "omni",
    sharesBrief: false,
    body: (message, preferences) => ({ message, preferences }),
  },
  oai_codex: {
    label: "OAI Codex",
    subtitle: "OpenAI managed Codex harness · Agents API",
    mark: "X",
    endpoint: "/api/oai-codex-conversation",
    runtimeHeader: "oai_codex",
    trace: "omni",
    sharesBrief: false,
    body: (message, preferences) => ({ message, preferences }),
  },
});

const PANE_RUNTIME_OPTIONS: readonly ComparePaneRuntime[] = ["omni", "oai_codex", "albert", "codex"];

const traceEventTypes = new Set([
  "progress", "narrative", "plan", "query", "table", "chart",
  "validation", "answer", "clarification", "error",
  "tasks", "research", "dashboard_plan",
]);
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

type PaneKey = "left" | "right";
const PANE_KEYS: readonly PaneKey[] = ["left", "right"];
type PaneStatus = "idle" | "starting" | "running" | "complete" | "error" | "stopped";

type PaneState = Readonly<{
  status: PaneStatus;
  events: readonly TraceEvent[];
  conversationId?: string;
  turnId?: string;
  startedAt?: number;
  firstEvidenceAt?: number;
  answerAt?: number;
  completedAt?: number;
}>;

const emptyPane: PaneState = Object.freeze({ status: "idle", events: Object.freeze([]) });

function parseTraceEvent(value: unknown): TraceEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.sequence !== "number"
    || typeof candidate.type !== "string"
    || !traceEventTypes.has(candidate.type)
    || typeof candidate.occurredAt !== "string"
  ) return null;
  return candidate as unknown as TraceEvent;
}

function localErrorEvent(message: string, sequence: number): TraceEvent {
  return {
    id: `compare_error_${crypto.randomUUID()}`,
    sequence,
    type: "error",
    status: "error",
    occurredAt: new Date().toISOString(),
    message: message.replace(/\s+/gu, " ").trim().slice(0, 400),
    recoverable: true,
  };
}

function durationLabel(milliseconds: number | undefined): string {
  if (milliseconds === undefined || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function paneTiming(pane: PaneState, now: number): Readonly<{
  firstEvidence?: number;
  answer?: number;
  total?: number;
}> {
  if (!pane.startedAt) return {};
  return {
    ...(pane.firstEvidenceAt ? { firstEvidence: pane.firstEvidenceAt - pane.startedAt } : {}),
    ...(pane.answerAt ? { answer: pane.answerAt - pane.startedAt } : {}),
    total: (pane.completedAt ?? now) - pane.startedAt,
  };
}

function isEvidenceEvent(event: TraceEvent): boolean {
  return event.type === "query"
    || event.type === "table"
    || event.type === "validation"
    || event.type === "answer"
    || event.type === "clarification";
}

function isAnswerEvent(event: TraceEvent): boolean {
  return event.type === "answer" || event.type === "clarification";
}

function paneAnswerState(pane: PaneState): string | undefined {
  for (const event of [...pane.events].reverse()) {
    if (event.type === "answer") return event.state;
    if (event.type === "clarification") return "Clarification";
  }
  return undefined;
}

function statusLabel(status: PaneStatus): string {
  if (status === "starting") return "Starting";
  if (status === "running") return "Working";
  if (status === "complete") return "Complete";
  if (status === "error") return "Failed";
  if (status === "stopped") return "Stopped";
  return "Ready";
}

function preferenceLabel(preferences: AgentRunPreferences): string {
  const effort = preferences.reasoningEffort === "xhigh"
    ? "XHigh"
    : `${preferences.reasoningEffort.slice(0, 1).toUpperCase()}${preferences.reasoningEffort.slice(1)}`;
  return `${albertModelById(preferences.model).label} · ${effort} · ${preferences.fastMode ? "Fast" : "Standard"}`;
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string"
    ? payload.error.slice(0, 400)
    : `The ${response.status} response could not start this comparison.`;
}

export default function RuntimeComparisonWorkspace(props: Readonly<{
  organisationName: string;
  /** Which two runtimes the view opens with; either side can be changed while idle. */
  defaultPair?: ComparePair;
  onSelectRuntime: (runtime: ConversationRuntimeTab) => void;
  onConversationsChanged: () => void | Promise<void>;
}>): React.ReactNode {
  const [pair, setPair] = useState<ComparePair>(props.defaultPair ?? HARNESS_COMPARE_PAIR);
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState("");
  const [preferences, setPreferences] = useState<AgentRunPreferences>(COMPARE_DEFAULT_PREFERENCES);
  const [runPreferences, setRunPreferences] = useState<AgentRunPreferences>(COMPARE_DEFAULT_PREFERENCES);
  const [runPair, setRunPair] = useState<ComparePair>(props.defaultPair ?? HARNESS_COMPARE_PAIR);
  const [runId, setRunId] = useState(0);
  const [panes, setPanes] = useState<Readonly<Record<PaneKey, PaneState>>>({
    left: emptyPane,
    right: emptyPane,
  });
  const [now, setNow] = useState(() => Date.now());
  const controllersRef = useRef<Readonly<Record<PaneKey, AbortController>> | null>(null);
  const briefDigestsRef = useRef<Partial<Record<PaneKey, string>>>({});
  const activeRunIdRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isRunning = panes.left.status === "starting"
    || panes.left.status === "running"
    || panes.right.status === "starting"
    || panes.right.status === "running";
  const hasRun = runId > 0;
  const displayedPair = hasRun ? runPair : pair;
  const leftProfile = PANE_PROFILES[displayedPair[0]];
  const rightProfile = PANE_PROFILES[displayedPair[1]];
  const sharesBrief = leftProfile.sharesBrief && rightProfile.sharesBrief;

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  useEffect(() => () => {
    controllersRef.current?.left.abort("comparison_unmounted");
    controllersRef.current?.right.abort("comparison_unmounted");
  }, []);

  const updatePane = useCallback((
    key: PaneKey,
    expectedRunId: number,
    update: (current: PaneState) => PaneState,
  ) => {
    setPanes((current) => {
      if (expectedRunId !== activeRunIdRef.current) return current;
      return { ...current, [key]: update(current[key]) };
    });
  }, []);

  const executePane = useCallback(async (input: Readonly<{
    key: PaneKey;
    runtime: ComparePaneRuntime;
    otherRuntime: ComparePaneRuntime;
    expectedRunId: number;
    message: string;
    startedAt: number;
    controller: AbortController;
    preferences: AgentRunPreferences;
  }>) => {
    const profile = PANE_PROFILES[input.runtime];
    const otherProfile = PANE_PROFILES[input.otherRuntime];
    const received: TraceEvent[] = [];
    try {
      const response = await fetch(profile.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile.body(input.message, input.preferences)),
        signal: input.controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (response.headers.get("X-Albert-Runtime") !== profile.runtimeHeader) {
        await response.body?.cancel("comparison_runtime_mismatch");
        throw new Error(`${profile.label} returned the wrong runtime.`);
      }
      if (response.headers.get("X-Albert-Model") !== input.preferences.model) {
        await response.body?.cancel("comparison_model_mismatch");
        throw new Error(`${profile.label} did not use the shared comparison model.`);
      }
      if (input.runtime === "albert" && response.headers.get("X-Albert-Specialist-Agent") !== "general") {
        await response.body?.cancel("comparison_specialist_mismatch");
        throw new Error("Albert did not use the general comparison profile.");
      }
      // Engine panes prove they analysed the same frozen brief; harness
      // panes share the governed tool set instead and carry no brief.
      if (profile.sharesBrief && otherProfile.sharesBrief) {
        const briefDigest = response.headers.get("X-Albert-Analysis-Brief") ?? "";
        briefDigestsRef.current[input.key] = briefDigest;
        const otherKey: PaneKey = input.key === "left" ? "right" : "left";
        const otherDigest = briefDigestsRef.current[otherKey];
        if (otherDigest !== undefined && otherDigest !== briefDigest) {
          await response.body?.cancel("comparison_brief_mismatch");
          throw new Error("The runtimes did not receive the same frozen analytical brief.");
        }
      }
      const conversationId = response.headers.get("X-Albert-Conversation-Id") ?? "";
      const turnId = response.headers.get("X-Albert-Turn-Id") ?? "";
      if (!ulidPattern.test(conversationId) || !ulidPattern.test(turnId)) {
        await response.body?.cancel("comparison_missing_turn_identity");
        throw new Error("The governed stream omitted its immutable turn identity.");
      }
      updatePane(input.key, input.expectedRunId, (current) => ({
        ...current,
        status: "running",
        conversationId,
        turnId,
      }));
      if (!response.body) throw new Error("The governed comparison stream was unavailable.");
      const reader = response.body.getReader();
      const cancelReader = () => void reader.cancel("comparison_stopped").catch(() => undefined);
      input.controller.signal.addEventListener("abort", cancelReader, { once: true });
      const decoder = new TextDecoder();
      let buffer = "";
      const acceptBlock = (block: string) => {
        const lines = block.split("\n");
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
        if (eventName !== "trace") return;
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) return;
        let event: TraceEvent | null = null;
        try { event = parseTraceEvent(JSON.parse(data)); } catch { return; }
        if (!event || received.some((candidate) => candidate.id === event!.id)) return;
        received.push(event);
        received.sort((left, right) => left.sequence - right.sequence);
        const signalAt = Date.now();
        updatePane(input.key, input.expectedRunId, (current) => ({
          ...current,
          status: "running",
          events: [...received],
          ...(!current.firstEvidenceAt && isEvidenceEvent(event!) ? { firstEvidenceAt: signalAt } : {}),
          ...(!current.answerAt && isAnswerEvent(event!) ? { answerAt: signalAt } : {}),
        }));
      };
      for (;;) {
        if (input.controller.signal.aborted) break;
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          acceptBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      input.controller.signal.removeEventListener("abort", cancelReader);
      if (input.controller.signal.aborted) {
        const stopped = localErrorEvent("Stopped.", received.length + 1);
        updatePane(input.key, input.expectedRunId, (current) => ({
          ...current,
          status: "stopped",
          completedAt: Date.now(),
          events: [...received, stopped],
        }));
        return;
      }
      if (buffer.trim()) acceptBlock(buffer);
      if (received.length === 0) throw new Error("The runtime returned an empty analysis trace.");
      const answered = received.some((event) => event.type === "answer" || event.type === "clarification");
      const runtimeErrored = received.some((event) => event.type === "error");
      const terminalEvents = answered || runtimeErrored
        ? [...received]
        : [...received, localErrorEvent("The runtime ended without a terminal answer.", received.length + 1)];
      updatePane(input.key, input.expectedRunId, (current) => ({
        ...current,
        status: answered ? "complete" : "error",
        completedAt: Date.now(),
        events: terminalEvents,
      }));
    } catch (error) {
      const stopped = input.controller.signal.aborted;
      const message = stopped
        ? "Stopped."
        : error instanceof Error ? error.message : "The comparison runtime failed.";
      const event = localErrorEvent(message, received.length + 1);
      updatePane(input.key, input.expectedRunId, (current) => ({
        ...current,
        status: stopped ? "stopped" : "error",
        completedAt: Date.now(),
        events: [...received, event],
      }));
    }
  }, [updatePane]);

  const startComparison = useCallback((messageOverride?: string) => {
    const message = (messageOverride ?? draft).trim();
    if (!message || isRunning) return;
    controllersRef.current?.left.abort("comparison_replaced");
    controllersRef.current?.right.abort("comparison_replaced");
    const nextRunId = runId + 1;
    const startedAt = Date.now();
    const preferencesSnapshot = Object.freeze({ ...preferences });
    const pairSnapshot: ComparePair = [pair[0], pair[1]];
    const controllers = Object.freeze({
      left: new AbortController(),
      right: new AbortController(),
    });
    controllersRef.current = controllers;
    briefDigestsRef.current = {};
    activeRunIdRef.current = nextRunId;
    setQuestion(message);
    setRunPreferences(preferencesSnapshot);
    setRunPair(pairSnapshot);
    setDraft("");
    setRunId(nextRunId);
    setNow(startedAt);
    setPanes({
      left: { status: "starting", events: [], startedAt },
      right: { status: "starting", events: [], startedAt },
    });
    void Promise.allSettled([
      executePane({
        key: "left",
        runtime: pairSnapshot[0],
        otherRuntime: pairSnapshot[1],
        expectedRunId: nextRunId,
        message,
        startedAt,
        controller: controllers.left,
        preferences: preferencesSnapshot,
      }),
      executePane({
        key: "right",
        runtime: pairSnapshot[1],
        otherRuntime: pairSnapshot[0],
        expectedRunId: nextRunId,
        message,
        startedAt,
        controller: controllers.right,
        preferences: preferencesSnapshot,
      }),
    ]).then(() => props.onConversationsChanged());
  }, [draft, executePane, isRunning, pair, preferences, props, runId]);

  const stopBoth = useCallback(() => {
    controllersRef.current?.left.abort("comparison_stopped");
    controllersRef.current?.right.abort("comparison_stopped");
  }, []);

  const resetComparison = useCallback(() => {
    stopBoth();
    setQuestion("");
    setDraft("");
    setRunId(0);
    activeRunIdRef.current = 0;
    setPanes({ left: emptyPane, right: emptyPane });
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [stopBoth]);

  const comparisonSummary = useMemo(() => {
    if (panes.left.status !== "complete" || panes.right.status !== "complete") return null;
    const left = paneTiming(panes.left, now).answer;
    const right = paneTiming(panes.right, now).answer;
    if (left === undefined || right === undefined) return null;
    return `Observed answer times · ${leftProfile.label} ${durationLabel(left)} · ${rightProfile.label} ${durationLabel(right)}`;
  }, [leftProfile.label, now, panes, rightProfile.label]);

  const displayedPreferences = hasRun ? runPreferences : preferences;
  const displayedPreferenceLabel = preferenceLabel(displayedPreferences);
  const composerLabel = `Ask both ${leftProfile.label} and ${rightProfile.label}`;

  const changePaneRuntime = (key: PaneKey, runtime: ComparePaneRuntime) => {
    if (isRunning) return;
    setPair((current) => (key === "left" ? [runtime, current[1]] : [current[0], runtime]));
  };

  const renderPane = (key: PaneKey) => {
    const pane = panes[key];
    const timing = paneTiming(pane, now);
    const runtime = key === "left" ? displayedPair[0] : displayedPair[1];
    const profile = PANE_PROFILES[runtime];
    const label = profile.label;
    return (
      <section className={styles.comparePane} aria-label={`${label} comparison result`}>
        <header className={styles.comparePaneHeader}>
          <div>
            <div className={styles.comparePaneIdentity}>
              <span className={styles.comparePaneMark} data-runtime={runtime} aria-hidden="true" />
              <h2>{label}</h2>
              <span className={styles.comparePaneStatus} data-status={pane.status}>
                {statusLabel(pane.status)}
              </span>
            </div>
            <p>{profile.subtitle} · {displayedPreferenceLabel}</p>
          </div>
          <div className={styles.comparePaneHeaderActions}>
            {!hasRun ? (
              <select
                className={styles.comparePaneSelect}
                aria-label={`${key === "left" ? "Left" : "Right"} pane runtime`}
                data-testid={`compare-pane-runtime-${key}`}
                value={runtime}
                disabled={isRunning}
                onChange={(event) => changePaneRuntime(key, event.target.value as ComparePaneRuntime)}
              >
                {PANE_RUNTIME_OPTIONS.map((option) => (
                  <option key={option} value={option}>{PANE_PROFILES[option].label}</option>
                ))}
              </select>
            ) : null}
            {pane.startedAt ? (
              <dl className={styles.comparePaneTiming} aria-label={`${label} timings`}>
                <div><dt>Evidence</dt><dd>{durationLabel(timing.firstEvidence)}</dd></div>
                <div><dt>Answer</dt><dd>{durationLabel(timing.answer)}</dd></div>
              </dl>
            ) : null}
            {pane.status === "starting" || pane.status === "running" ? (
              <button
                className={styles.comparePaneStop}
                type="button"
                aria-label={`Stop ${label}`}
                onClick={() => controllersRef.current?.[key].abort(`stop_${key}`)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
              </button>
            ) : null}
          </div>
        </header>
        <div className={styles.comparePaneBody}>
          {pane.events.length > 0 || pane.status === "starting" || pane.status === "running" ? (
            profile.trace === "omni" ? (
              <OmniTrace
                events={pane.events}
                streaming={pane.status === "starting" || pane.status === "running"}
                onFollowUp={(prompt) => {
                  setDraft(prompt);
                  window.requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              />
            ) : (
              <InsightsStyleTrace
                events={pane.events}
                streaming={pane.status === "starting" || pane.status === "running"}
                detailedMode={false}
                runtime={runtime === "albert" ? "v3" : runtime}
                onFollowUp={(prompt) => {
                  setDraft(prompt);
                  window.requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                onAddToChat={(text) => setDraft((current) => current ? `${current}\n\n${text}` : text)}
              />
            )
          ) : (
            <div className={styles.comparePaneEmpty}>
              <span aria-hidden="true">{profile.mark}</span>
              <p>{label} will begin at the same moment.</p>
            </div>
          )}
        </div>
        {paneAnswerState(pane) ? (
          <footer className={styles.comparePaneFooter}>Answer state · {paneAnswerState(pane)}</footer>
        ) : null}
      </section>
    );
  };

  return (
    <div className={styles.compareShell}>
      <header className={styles.compareTopBar}>
        <div className={styles.compareTopIdentity}>
          <h1 id="dash-title">Compare · {props.organisationName}</h1>
        </div>
        <div className={styles.compareTopActions}>
          <HarnessSelector
            value="compare"
            onChange={(choice) => props.onSelectRuntime(choice)}
          />
          {hasRun && !isRunning ? (
            <button type="button" onClick={resetComparison}>New comparison</button>
          ) : null}
          {isRunning ? (
            <button type="button" onClick={stopBoth}>Stop both</button>
          ) : null}
        </div>
      </header>

      {!hasRun ? (
        <div className={styles.compareIntro}>
          <span className={styles.compareEyebrow}>Side-by-side analysis</span>
          <h2>Ask once. Watch both analyse.</h2>
          <p>
            {sharesBrief
              ? `${leftProfile.label} and ${rightProfile.label} receive the exact same question, model, reasoning level and Fast tier, then investigate independently through Albert’s governed data boundaries.`
              : `${leftProfile.label} and ${rightProfile.label} receive the exact same question, model, reasoning level and Fast tier, and work the same governed semantic tools; only the agent loop driving the model differs.`}
          </p>
          <small>Runs two governed turns. Each answer is saved as its own runtime-locked conversation.</small>
        </div>
      ) : (
        <div className={styles.compareQuestion}>
          <span>Shared question</span>
          <p>{question}</p>
        </div>
      )}

      <div className={styles.compareGrid}>
        {PANE_KEYS.map((key) => (
          <div key={key} style={{ display: "contents" }}>{renderPane(key)}</div>
        ))}
      </div>

      <div className={styles.compareConditions} aria-label="Comparison conditions">
        <span>Same prompt</span>
        <span>{sharesBrief ? "Same analytical brief" : "Same governed tools"}</span>
        <span>Same settings · {displayedPreferenceLabel}</span>
        <span>{sharesBrief ? "Independent prompts and tool sets" : "Independent agent loops"}</span>
        <span>Live reads · not a frozen benchmark</span>
      </div>

      {comparisonSummary ? (
        <div className={styles.compareSummary} role="status">
          <span>{comparisonSummary}</span>
          <small>One observed run is not a speed benchmark; answer quality is yours to compare.</small>
        </div>
      ) : null}

      <form
        className={styles.compareComposer}
        onSubmit={(event) => {
          event.preventDefault();
          startComparison();
        }}
      >
        <ModelRunControls
          value={preferences}
          onChange={setPreferences}
          allowedModelIds={COMPARE_MODEL_IDS}
          allowedReasoningEfforts={COMPARE_REASONING_EFFORTS}
          disabled={isRunning}
          popoverPlacement="above"
        />
        <textarea
          ref={textareaRef}
          rows={1}
          aria-label={composerLabel}
          placeholder={hasRun ? "Compare another question…" : "Ask both agents the same question…"}
          value={draft}
          disabled={isRunning}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              startComparison();
            }
          }}
        />
        {isRunning ? (
          <button type="button" aria-label="Stop both comparisons" onClick={stopBoth}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
          </button>
        ) : (
          <button type="submit" aria-label="Compare answers" disabled={!draft.trim()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 13 6-6 6 6M12 7v11" /></svg>
          </button>
        )}
      </form>
    </div>
  );
}
