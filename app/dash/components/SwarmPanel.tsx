"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { TraceEvent } from "@/packages/shared/src";
import InsightsStyleTrace from "./InsightsStyleTrace";
import {
  stopSwarmFleet,
  subscribeSwarmRun,
  swarmRunSnapshot,
  type SwarmAgentLiveState,
} from "../lib/swarm-run-controller";
import styles from "./swarm-panel.module.css";

const traceEventTypes = new Set([
  "progress", "narrative", "plan", "query", "table", "chart",
  "validation", "answer", "clarification", "error",
]);

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

function isActive(phase: SwarmAgentLiveState["phase"]): boolean {
  return phase === "pending" || phase === "starting" || phase === "researching" || phase === "recording";
}

function CloseIcon(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m14 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AgentRow({
  agent,
  onOpen,
}: Readonly<{
  agent: SwarmAgentLiveState;
  onOpen: () => void;
}>): React.ReactNode {
  const live = isActive(agent.phase);
  return (
    <button className={styles.row} type="button" onClick={onOpen}>
      <span
        className={`${styles.dot} ${
          live ? styles.dotLive
            : agent.phase === "failed" ? styles.dotFailed
              : styles.dotDone
        }`}
        aria-hidden="true"
      />
      <span className={styles.copy}>
        <span className={styles.title}>{agent.title}</span>
        <span className={styles.status}>
          {agent.headline ?? agent.statusLine}
        </span>
      </span>
    </button>
  );
}

export default function SwarmPanel({
  onClose,
}: Readonly<{
  onClose: () => void;
}>): React.ReactNode {
  const snapshot = useSyncExternalStore(subscribeSwarmRun, swarmRunSnapshot, swarmRunSnapshot);
  const [inspectKey, setInspectKey] = useState<string | null>(null);
  const [inspectEvents, setInspectEvents] = useState<readonly TraceEvent[]>([]);
  const [inspectState, setInspectState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const inspect = snapshot.agents.find((agent) => agent.key === inspectKey) ?? null;
  const active = snapshot.agents.filter((agent) => isActive(agent.phase));
  const done = snapshot.agents.filter((agent) => !isActive(agent.phase));
  const finishedCount = done.length;

  useEffect(() => {
    if (!inspect?.conversationId) {
      setInspectEvents([]);
      setInspectState(inspect ? "idle" : "idle");
      return;
    }
    let cancelled = false;
    setInspectState("loading");
    void fetch(`/api/conversations/${inspect.conversationId}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled) return;
        const history = payload && typeof payload === "object"
          ? (payload as { history?: { turns?: unknown } }).history
          : null;
        const turns = history && Array.isArray(history.turns) ? history.turns : [];
        const last = [...turns].reverse().find((turn) => (
          turn && typeof turn === "object" && Array.isArray((turn as { events?: unknown }).events)
        )) as { events?: unknown[] } | undefined;
        const events = (last?.events ?? [])
          .map(parseTraceEvent)
          .filter((event): event is TraceEvent => event !== null)
          .sort((left, right) => left.sequence - right.sequence);
        setInspectEvents(events);
        setInspectState("ready");
      })
      .catch(() => {
        if (!cancelled) setInspectState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [inspect?.conversationId]);

  return (
    <div className={styles.inner}>
      <header className={styles.header}>
        {inspect ? (
          <button
            className={styles.back}
            type="button"
            aria-label="Back to swarm"
            onClick={() => setInspectKey(null)}
          >
            <BackIcon />
          </button>
        ) : null}
        <h2>{inspect ? inspect.title : "Swarm"}</h2>
        {!inspect && snapshot.agents.length > 0 ? (
          <span className={styles.count}>{finishedCount} of {snapshot.agents.length} done</span>
        ) : null}
        <button className={styles.close} type="button" aria-label="Close swarm" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      {inspect ? (
        <div className={styles.trace}>
          {inspectState === "loading" ? (
            <p className={styles.traceState}>Loading this specialist…</p>
          ) : inspectState === "error" ? (
            <p className={styles.traceState}>This specialist's conversation could not be loaded.</p>
          ) : inspectEvents.length === 0 ? (
            <p className={styles.traceState}>{inspect.statusLine}</p>
          ) : (
            <InsightsStyleTrace
              events={inspectEvents}
              streaming={isActive(inspect.phase)}
              detailedMode
              runtime="codex"
            />
          )}
        </div>
      ) : (
        <>
          <div className={styles.body}>
            <section>
              <h3 className={styles.sectionTitle}>Active · {active.length}</h3>
              {active.length === 0 ? (
                <p className={styles.empty}>
                  {snapshot.synthesising
                    ? "Combining the findings…"
                    : snapshot.answer
                      ? "All specialists have finished."
                      : "No specialists running."}
                </p>
              ) : (
                <div className={styles.list}>
                  {active.map((agent) => (
                    <AgentRow
                      key={agent.key}
                      agent={agent}
                      onOpen={() => setInspectKey(agent.key)}
                    />
                  ))}
                </div>
              )}
            </section>
            <section>
              <h3 className={styles.sectionTitle}>Done · {done.length}</h3>
              {done.length === 0 ? (
                <p className={styles.empty}>Finished specialists will land here.</p>
              ) : (
                <div className={styles.list}>
                  {done.map((agent) => (
                    <AgentRow
                      key={agent.key}
                      agent={agent}
                      onOpen={() => setInspectKey(agent.key)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
          {snapshot.active ? (
            <div className={styles.footer}>
              <button className={styles.stop} type="button" onClick={() => stopSwarmFleet()}>
                Stop swarm
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
