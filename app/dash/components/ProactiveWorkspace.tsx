"use client";

/**
 * The Proactive control panel (ADR 0113).
 *
 * One Start press deploys the research roster — every agent a real Terra-max
 * codex conversation. The finished panel is a three-tier morning brief: a
 * plain-English verdict, the few findings that deserve attention (each with
 * the question worth asking next), and a collapsed list of everything else.
 * Density lives one click deeper: the explore popup and the side chat, which
 * continues the agent's own conversation.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { renderAssistantMarkdown } from "../lib/render-assistant-markdown";
import {
  proactiveRunSnapshot,
  startProactiveFleet,
  subscribeProactiveRun,
  type ProactiveAgentLiveState,
  type ProactiveFleetAgent,
  type ProactiveFleetPreferences,
} from "../lib/proactive-run-controller";
import ProactiveSideChat from "./ProactiveSideChat";
import traceStyles from "./insights-trace.module.css";
import styles from "./proactive-workspace.module.css";

type PanelKeyNumber = Readonly<{ label: string; value: string }>;

type PanelFinding = Readonly<{
  findingId: string;
  agentKey: string;
  agentTitle: string;
  agentTagline: string;
  sequence: number;
  status: "pending" | "running" | "completed" | "failed";
  conversationId: string | null;
  turnId: string | null;
  answerState: string | null;
  headline: string | null;
  summary: string | null;
  keyNumbers: readonly PanelKeyNumber[];
  questions: readonly string[];
  failureNote: string | null;
  startedAt: string | null;
  completedAt: string | null;
  prompt: string | null;
}>;

type PanelSynthesisHighlight = Readonly<{
  agentKey: string;
  tone: "good" | "attention" | "opportunity";
  headline: string;
  why: string;
  question: string;
}>;

type PanelSynthesis = Readonly<{
  verdict: string;
  highlights: readonly PanelSynthesisHighlight[];
  quietLine: string;
}>;

type PanelRun = Readonly<{
  runId: string;
  status: "running" | "completed" | "failed" | "abandoned";
  agentCount: number;
  model: string;
  reasoningEffort: string;
  startedAt: string;
  completedAt: string | null;
  synthesis: PanelSynthesis | null;
  findings: readonly PanelFinding[];
}>;

type PanelQuestion = Readonly<{ text: string; category: string }>;

type PanelQuestionBank = Readonly<{
  questions: readonly PanelQuestion[];
  generatedAt: string;
}>;

type PanelData = Readonly<{
  run: PanelRun | null;
  questionBank: PanelQuestionBank | null;
  conversationIds: readonly string[];
  availableAgents: readonly Readonly<{ key: string; title: string; tagline: string }>[];
  activeConnectors: readonly string[];
  canRun: boolean;
  model: string;
  reasoningEffort: string;
  concurrency: number;
  timezone: string;
}>;

type PanelState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; data: PanelData }>;

type SideChatTarget = Readonly<{
  /** Null opens a fresh codex conversation for a question-wall pick. */
  conversationId: string | null;
  title: string;
  initialQuestion: string | null;
}>;

const ANSWER_STATE_TONE: Readonly<Record<string, "good" | "warn" | "muted">> = {
  Verified: "good",
  Qualified: "warn",
  Exploratory: "warn",
  Clarification: "muted",
  "No data": "muted",
  Unavailable: "muted",
};

const HIGHLIGHT_TONE_LABEL: Readonly<Record<PanelSynthesisHighlight["tone"], string>> = {
  good: "Going well",
  attention: "Needs attention",
  opportunity: "Worth testing",
};

function formatPanelTime(value: string | null, timezone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const now = new Date();
  const sameDay = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, dateStyle: "short" });
  const time = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
  if (sameDay.format(date) === sameDay.format(now)) return `today at ${time}`;
  const day = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "long", day: "numeric", month: "short" }).format(date);
  return `${day} at ${time}`;
}

const STICKER_ROTATIONS = [-2.2, 1.6, -1.2, 2.3, -0.8, 1.1, -1.7, 0.6] as const;

/**
 * The ranked highlights as a bento grid: rank decides real estate, content is
 * deliberately uniform — tone, area, headline, Learn more. The depth (why,
 * questions, evidence) lives behind Learn more in the explore popup.
 */
function HighlightBento({
  highlights,
  findingsByKey,
  onLearnMore,
}: Readonly<{
  highlights: readonly PanelSynthesisHighlight[];
  findingsByKey: ReadonlyMap<string, PanelFinding>;
  onLearnMore: (finding: PanelFinding, highlight: PanelSynthesisHighlight) => void;
}>) {
  return (
    <div className={styles.bentoGrid} aria-label="Needs your attention">
      {highlights.map((highlight, index) => {
        const finding = findingsByKey.get(highlight.agentKey);
        const size = index === 0 ? styles.bentoHero : index === 1 ? styles.bentoTall : styles.bentoSmall;
        return (
          <article key={highlight.agentKey} className={`${styles.bentoCard} ${size}`} data-tone={highlight.tone}>
            <span className={styles.bentoTone} data-tone={highlight.tone}>
              {HIGHLIGHT_TONE_LABEL[highlight.tone]}
            </span>
            <span className={styles.bentoArea}>{finding?.agentTitle ?? highlight.agentKey}</span>
            <h3 className={styles.bentoHeadline}>{highlight.headline}</h3>
            {finding ? (
              <div className={styles.bentoActions}>
                <button
                  type="button"
                  className={styles.secondaryAction}
                  onClick={() => onLearnMore(finding, highlight)}
                >
                  Learn more
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

async function fetchPanel(): Promise<PanelData> {
  const response = await fetch("/api/proactive", { cache: "no-store" });
  const payload = await response.json().catch(() => null) as (PanelData & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || "Proactive research is unavailable right now.");
  }
  return payload;
}

export default function ProactiveWorkspace({
  onOpenConversation,
  onProactiveConversationIds,
}: Readonly<{
  onOpenConversation?: (conversationId: string) => void;
  onProactiveConversationIds?: (ids: readonly string[]) => void;
}>) {
  const reduceMotion = useReducedMotion() ?? false;
  const [panel, setPanel] = useState<PanelState>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [explore, setExplore] = useState<Readonly<{
    finding: PanelFinding;
    leadQuestion: string | null;
  }> | null>(null);
  const [sideChat, setSideChat] = useState<SideChatTarget | null>(null);
  const [allAreasOpen, setAllAreasOpen] = useState(false);
  const [synthesisPending, setSynthesisPending] = useState(false);
  const [questionsRefreshing, setQuestionsRefreshing] = useState(false);
  const live = useSyncExternalStore(subscribeProactiveRun, proactiveRunSnapshot, proactiveRunSnapshot);
  const conversationIdsCallbackRef = useRef(onProactiveConversationIds);
  conversationIdsCallbackRef.current = onProactiveConversationIds;
  const synthesisRequestedRef = useRef<string | null>(null);

  const loadPanel = useCallback(async () => {
    try {
      const data = await fetchPanel();
      setPanel({ kind: "ready", data });
      conversationIdsCallbackRef.current?.(data.conversationIds);
    } catch (error) {
      setPanel((current) => current.kind === "ready"
        ? current
        : { kind: "error", message: error instanceof Error ? error.message : "Proactive research is unavailable." });
    }
  }, []);

  useEffect(() => {
    void loadPanel();
  }, [loadPanel]);

  // Every settled agent refreshes the distilled findings from the server.
  useEffect(() => {
    if (live.settledCount === 0) return;
    const task = window.setTimeout(() => void loadPanel(), 600);
    return () => window.clearTimeout(task);
  }, [live.settledCount, loadPanel]);

  const data = panel.kind === "ready" ? panel.data : null;
  const run = data?.run ?? null;
  const liveByKey = useMemo(() => {
    const map = new Map<string, ProactiveAgentLiveState>();
    if (run && live.runId === run.runId) {
      for (const agent of live.agents) map.set(agent.key, agent);
    }
    return map;
  }, [live, run]);

  const fleetIsLive = run !== null && live.runId === run.runId && live.active;
  const interrupted = run !== null && run.status === "running" && !fleetIsLive;
  const completedCount = run
    ? run.findings.filter((finding) => {
        const overlay = liveByKey.get(finding.agentKey);
        return overlay ? overlay.phase === "done" : finding.status === "completed";
      }).length
    : 0;
  const failedCount = run
    ? run.findings.filter((finding) => {
        const overlay = liveByKey.get(finding.agentKey);
        return overlay ? overlay.phase === "failed" : finding.status === "failed";
      }).length
    : 0;
  const findingsByKey = useMemo(
    () => new Map((run?.findings ?? []).map((finding) => [finding.agentKey, finding])),
    [run],
  );

  // A completed run without a brief gets one written automatically.
  useEffect(() => {
    if (!run || !data?.canRun || fleetIsLive) return;
    if (run.status !== "completed" || run.synthesis || completedCount < 2) return;
    if (synthesisRequestedRef.current === run.runId) return;
    synthesisRequestedRef.current = run.runId;
    setSynthesisPending(true);
    void fetch("/api/proactive/synthesis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.runId }),
    })
      .then(() => loadPanel())
      .catch(() => undefined)
      .finally(() => setSynthesisPending(false));
  }, [completedCount, data?.canRun, fleetIsLive, loadPanel, run]);

  const refreshQuestions = useCallback(async () => {
    setQuestionsRefreshing(true);
    try {
      await fetch("/api/proactive/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await loadPanel();
    } catch {
      // The wall keeps its previous questions on failure.
    } finally {
      setQuestionsRefreshing(false);
    }
  }, [loadPanel]);

  const launchFleet = useCallback((
    runId: string,
    agents: readonly ProactiveFleetAgent[],
    preferences: ProactiveFleetPreferences,
    concurrency: number,
    alreadySettled: Parameters<typeof startProactiveFleet>[0]["alreadySettled"] = [],
  ) => {
    startProactiveFleet({ runId, agents, preferences, concurrency, alreadySettled });
  }, []);

  const startRun = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const response = await fetch("/api/proactive/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => null) as {
        run?: PanelRun;
        agents?: readonly ProactiveFleetAgent[];
        preferences?: ProactiveFleetPreferences;
        concurrency?: number;
        error?: string;
      } | null;
      if (!response.ok || !payload?.run || !payload.agents || !payload.preferences) {
        throw new Error(payload?.error || "Proactive research could not be started.");
      }
      synthesisRequestedRef.current = null;
      launchFleet(payload.run.runId, payload.agents, payload.preferences, payload.concurrency ?? 5);
      await loadPanel();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Proactive research could not be started.");
    } finally {
      setStarting(false);
    }
  }, [launchFleet, loadPanel]);

  const resumeRun = useCallback(() => {
    if (!run || !data) return;
    const preferences: ProactiveFleetPreferences = {
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      fastMode: true,
    };
    const toRun: ProactiveFleetAgent[] = [];
    const settled: NonNullable<Parameters<typeof startProactiveFleet>[0]["alreadySettled"]>[number][] = [];
    for (const finding of run.findings) {
      if (finding.status === "completed") {
        settled.push({
          key: finding.agentKey,
          title: finding.agentTitle,
          tagline: finding.agentTagline,
          headline: finding.headline,
          phase: "done",
        });
      } else if (finding.prompt) {
        toRun.push({
          key: finding.agentKey,
          title: finding.agentTitle,
          tagline: finding.agentTagline,
          prompt: finding.prompt,
        });
      }
    }
    if (toRun.length === 0) return;
    launchFleet(run.runId, toRun, preferences, data.concurrency, settled);
  }, [data, launchFleet, run]);

  const retryAgent = useCallback((finding: PanelFinding) => {
    if (!run || !data || !finding.prompt) return;
    const settled = run.findings
      .filter((other) => other.agentKey !== finding.agentKey)
      .map((other) => ({
        key: other.agentKey,
        title: other.agentTitle,
        tagline: other.agentTagline,
        headline: other.headline,
        phase: (other.status === "completed" ? "done" : "failed") as "done" | "failed",
      }));
    launchFleet(run.runId, [{
      key: finding.agentKey,
      title: finding.agentTitle,
      tagline: finding.agentTagline,
      prompt: finding.prompt,
    }], { model: run.model, reasoningEffort: run.reasoningEffort, fastMode: true }, 1, settled);
  }, [data, launchFleet, run]);

  const openExplore = useCallback((finding: PanelFinding, leadQuestion: string | null = null) => {
    setExplore({ finding, leadQuestion });
  }, []);

  const askQuestion = useCallback((finding: PanelFinding, question: string | null) => {
    if (!finding.conversationId) return;
    setExplore(null);
    setSideChat({
      conversationId: finding.conversationId,
      title: finding.agentTitle,
      initialQuestion: question,
    });
  }, []);

  if (panel.kind === "loading") {
    return (
      <div className={styles.workspace}>
        <div className={styles.stateBlock} role="status">
          <span className={styles.statePulse} aria-hidden="true" />
          <p>Loading your control panel…</p>
        </div>
      </div>
    );
  }
  if (panel.kind === "error") {
    return (
      <div className={styles.workspace}>
        <div className={styles.stateBlock} role="alert">
          <p>{panel.message}</p>
          <button type="button" className={styles.secondaryAction} onClick={() => { setPanel({ kind: "loading" }); void loadPanel(); }}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const panelData = panel.data;

  if (!run) {
    return (
      <div className={styles.workspace}>
        <div className={styles.hero}>
          <p className={styles.heroEyebrow}>PROACTIVE</p>
          <h2 className={styles.heroTitle}>
            Know how the business is really doing — before you ask.
          </h2>
          <p className={styles.heroLead}>
            Press Start and Albert deploys {panelData.availableAgents.length} research agents across sales,
            customers, inventory, cash, profit and payroll. You get back a short morning brief:
            how you&apos;re doing, the few things that need attention, and the questions worth asking.
          </p>
          {panelData.canRun ? (
            <>
              <button
                type="button"
                className={styles.startButton}
                onClick={() => void startRun()}
                disabled={starting}
              >
                {starting ? "Deploying agents…" : "Start proactive research"}
              </button>
              <p className={styles.heroNote}>
                A run takes several minutes and performs {panelData.availableAgents.length} deep analyses. Keep this window open.
              </p>
            </>
          ) : (
            <p className={styles.heroNote}>An owner or manager can start proactive research.</p>
          )}
          {startError ? <p className={styles.startError} role="alert">{startError}</p> : null}
          <div className={styles.rosterPreview} aria-label="Research areas">
            {panelData.availableAgents.map((agent) => (
              <div className={styles.rosterChip} key={agent.key}>
                <strong>{agent.title}</strong>
                <span>{agent.tagline}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const synthesis = run.synthesis;
  const highlightKeys = new Set((synthesis?.highlights ?? []).map((highlight) => highlight.agentKey));
  const quietFindings = run.findings.filter((finding) => !highlightKeys.has(finding.agentKey));

  return (
    <div className={styles.workspace}>
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.panelEyebrow}>
            {fleetIsLive
              ? `Researching — ${completedCount} of ${run.agentCount} complete`
              : run.status === "completed" || completedCount > 0
                ? `Researched ${formatPanelTime(run.completedAt ?? run.startedAt, panelData.timezone)}`
                : `Run started ${formatPanelTime(run.startedAt, panelData.timezone)}`}
          </p>
          <h2 className={styles.panelTitle}>
            {fleetIsLive ? "Agents are studying the business" : "Your morning brief"}
          </h2>
        </div>
        <div className={styles.panelHeaderActions}>
          {interrupted ? (
            <button type="button" className={styles.secondaryAction} onClick={resumeRun}>
              Resume interrupted run
            </button>
          ) : null}
          {panelData.canRun && !fleetIsLive ? (
            <button
              type="button"
              className={styles.startButtonCompact}
              onClick={() => void startRun()}
              disabled={starting}
            >
              {starting ? "Deploying…" : "Run again"}
            </button>
          ) : null}
        </div>
      </header>
      {fleetIsLive ? (
        <div className={styles.progressTrack} aria-hidden="true">
          <div
            className={styles.progressFill}
            style={{ width: `${Math.round(((completedCount + failedCount) / Math.max(run.agentCount, 1)) * 100)}%` }}
          />
        </div>
      ) : null}
      {startError ? <p className={styles.startError} role="alert">{startError}</p> : null}

      {fleetIsLive || interrupted ? (
        <div className={styles.cardGrid}>
          {run.findings.map((finding) => {
            const overlay = liveByKey.get(finding.agentKey);
            const phase = overlay
              ? overlay.phase
              : finding.status === "completed"
                ? "done"
                : finding.status === "failed"
                  ? "failed"
                  : finding.status === "running"
                    ? "researching"
                    : "pending";
            const busy = phase === "starting" || phase === "researching" || phase === "recording";
            return (
              <motion.article
                key={finding.agentKey}
                className={`${styles.card} ${busy ? styles.cardBusy : ""} ${phase === "pending" ? styles.cardPending : ""}`}
                layout={reduceMotion ? false : true}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className={styles.cardTop}>
                  <div>
                    <h3 className={styles.cardTitle}>{finding.agentTitle}</h3>
                    <p className={styles.cardTagline}>{finding.agentTagline}</p>
                  </div>
                  {phase === "done" ? (
                    <span className={styles.stateBadge} data-tone="good">Done</span>
                  ) : phase === "failed" ? (
                    <span className={styles.stateBadge} data-tone="muted">Failed</span>
                  ) : null}
                </div>
                {busy ? (
                  <div className={styles.cardStatus} role="status">
                    <span className={styles.cardPulse} aria-hidden="true" />
                    <span className={styles.cardStatusLine}>{overlay?.statusLine ?? "Researching…"}</span>
                    {overlay && overlay.queriesSeen > 0 ? (
                      <span className={styles.cardQueries}>{overlay.queriesSeen} quer{overlay.queriesSeen === 1 ? "y" : "ies"}</span>
                    ) : null}
                  </div>
                ) : phase === "pending" ? (
                  <div className={styles.cardStatus}>
                    <span className={styles.cardStatusLine}>Queued</span>
                  </div>
                ) : phase === "failed" ? (
                  <div className={styles.cardStatus}>
                    <span className={styles.cardStatusLine}>{finding.failureNote || overlay?.error || "Did not finish."}</span>
                  </div>
                ) : (
                  <p className={styles.cardHeadline}>{finding.headline ?? overlay?.headline ?? "Done."}</p>
                )}
              </motion.article>
            );
          })}
        </div>
      ) : (
        <>
          {synthesis ? (
            <section className={styles.verdictBlock} aria-label="How the business is doing">
              <p className={styles.verdict}>{synthesis.verdict}</p>
              <p className={styles.quietLine}>{synthesis.quietLine}</p>
            </section>
          ) : synthesisPending ? (
            <div className={styles.stateBlock} role="status">
              <span className={styles.statePulse} aria-hidden="true" />
              <p>Writing your morning brief…</p>
            </div>
          ) : null}

          {synthesis ? (
            <HighlightBento
              highlights={synthesis.highlights}
              findingsByKey={findingsByKey}
              onLearnMore={(finding, highlight) => openExplore(finding, highlight.question)}
            />
          ) : null}

          <section className={styles.allAreas} aria-label="All research areas">
            <button
              type="button"
              className={styles.allAreasToggle}
              aria-expanded={allAreasOpen || !synthesis}
              onClick={() => setAllAreasOpen((current) => !current)}
            >
              <span>
                {synthesis
                  ? `All ${run.findings.length} areas checked`
                  : `${run.findings.length} areas checked`}
              </span>
              <span className={styles.allAreasChevron} data-open={allAreasOpen || !synthesis}>›</span>
            </button>
            {(allAreasOpen || !synthesis) ? (
              <div className={styles.areaRows}>
                {(synthesis ? quietFindings : run.findings).concat(
                  synthesis ? run.findings.filter((finding) => highlightKeys.has(finding.agentKey)) : [],
                ).sort((left, right) => left.sequence - right.sequence).map((finding) => {
                  const tone = finding.status === "failed"
                    ? "muted"
                    : finding.answerState
                      ? ANSWER_STATE_TONE[finding.answerState] ?? "muted"
                      : "muted";
                  return (
                    <div className={styles.areaRow} key={finding.agentKey}>
                      <button
                        type="button"
                        className={styles.areaRowButton}
                        onClick={() => finding.status === "completed" && openExplore(finding)}
                        disabled={finding.status !== "completed"}
                      >
                        <span className={styles.areaDot} data-tone={tone} aria-hidden="true" />
                        <span className={styles.areaTitle}>{finding.agentTitle}</span>
                        <span className={styles.areaHeadline}>
                          {finding.status === "failed"
                            ? finding.failureNote || "Did not finish"
                            : finding.headline ?? "—"}
                        </span>
                      </button>
                      {finding.status === "failed" && panelData.canRun && finding.prompt ? (
                        <button type="button" className={styles.secondaryAction} onClick={() => retryAgent(finding)}>
                          Retry
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className={styles.questionWall} aria-label="Questions worth asking">
            <div className={styles.questionWallHeader}>
              <div>
                <h3 className={styles.questionWallTitle}>Questions worth asking</h3>
                <p className={styles.questionWallLead}>
                  Written for this business from its own data. Tap one and Albert answers it beside you.
                </p>
              </div>
              {panelData.canRun && panelData.questionBank && panelData.questionBank.questions.length > 0 ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  onClick={() => void refreshQuestions()}
                  disabled={questionsRefreshing}
                >
                  {questionsRefreshing ? "Rewriting…" : "Rewrite all questions"}
                </button>
              ) : null}
            </div>
            {panelData.questionBank && panelData.questionBank.questions.length > 0 ? (
              <div className={styles.stickerWall} data-refreshing={questionsRefreshing || undefined}>
                {panelData.questionBank.questions.map((question, index) => (
                  <button
                    key={`${question.category}-${question.text}`}
                    type="button"
                    className={styles.sticker}
                    data-palette={index % 5}
                    style={{ "--sticker-rotation": `${STICKER_ROTATIONS[index % STICKER_ROTATIONS.length]}deg` } as React.CSSProperties}
                    onClick={() => setSideChat({
                      conversationId: null,
                      title: "Your question",
                      initialQuestion: question.text,
                    })}
                  >
                    <span className={styles.stickerCategory}>{question.category}</span>
                    <span className={styles.stickerText}>{question.text}</span>
                  </button>
                ))}
              </div>
            ) : questionsRefreshing ? (
              <div className={styles.stateBlock} role="status">
                <span className={styles.statePulse} aria-hidden="true" />
                <p>Writing questions for this business… this takes a minute or two.</p>
              </div>
            ) : panelData.canRun ? (
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={() => void refreshQuestions()}
              >
                Write questions for this business
              </button>
            ) : null}
          </section>
        </>
      )}

      <AnimatePresence>
        {explore ? (
          <motion.div
            className={styles.popupBackdrop}
            role="presentation"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setExplore(null);
            }}
          >
            <motion.div
              className={styles.explorePopup}
              role="dialog"
              aria-modal="true"
              aria-labelledby="proactive-explore-title"
              initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.99 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <button type="button" className={styles.popupClose} aria-label="Close" onClick={() => setExplore(null)}>
                ×
              </button>
              <p className={styles.popupEyebrow}>{explore.finding.agentTitle}</p>
              <h3 id="proactive-explore-title" className={styles.popupHeadline}>
                {explore.finding.headline ?? "Research finding"}
              </h3>
              {explore.finding.keyNumbers.length > 0 ? (
                <dl className={styles.keyNumbers}>
                  {explore.finding.keyNumbers.map((number) => (
                    <div className={styles.keyNumber} key={`${explore.finding.agentKey}-${number.label}`}>
                      <dt>{number.label}</dt>
                      <dd>{number.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {explore.finding.summary ? (
                <div
                  className={`${traceStyles.assistantProse} ${styles.popupSummary}`}
                  dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(explore.finding.summary) }}
                />
              ) : null}
              <div className={styles.popupQuestions}>
                <p className={styles.popupQuestionsLabel}>Explore this further</p>
                {[...new Set([
                  ...(explore.leadQuestion ? [explore.leadQuestion] : []),
                  ...(explore.finding.questions.length > 0
                    ? explore.finding.questions
                    : [
                      "What is driving this, exactly?",
                      "What should I do about it this week?",
                    ]),
                ])].map((question) => (
                  <button
                    key={question}
                    type="button"
                    className={styles.questionChip}
                    onClick={() => askQuestion(explore.finding, question)}
                    disabled={!explore.finding.conversationId}
                  >
                    {question}
                  </button>
                ))}
              </div>
              <div className={styles.popupActions}>
                <button
                  type="button"
                  className={styles.secondaryAction}
                  onClick={() => askQuestion(explore.finding, null)}
                  disabled={!explore.finding.conversationId}
                >
                  Ask your own question
                </button>
                {explore.finding.conversationId && onOpenConversation ? (
                  <button
                    type="button"
                    className={styles.secondaryAction}
                    onClick={() => {
                      const conversationId = explore.finding.conversationId;
                      setExplore(null);
                      if (conversationId) onOpenConversation(conversationId);
                    }}
                  >
                    Open full analysis
                  </button>
                ) : null}
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {sideChat ? (
          <ProactiveSideChat
            key={sideChat.conversationId ?? `new:${sideChat.initialQuestion ?? ""}`}
            conversationId={sideChat.conversationId}
            title={sideChat.title}
            initialQuestion={sideChat.initialQuestion}
            model={panelData.model}
            reasoningEffort={panelData.reasoningEffort}
            onClose={() => setSideChat(null)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
