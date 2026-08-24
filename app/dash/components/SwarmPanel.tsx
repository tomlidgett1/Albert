"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { useReducedMotion } from "framer-motion";
import { ThinkingOrb } from "thinking-orbs";
import type { TraceEvent } from "@/packages/shared/src";
import InsightsStyleTrace from "./InsightsStyleTrace";
import {
  stopSwarmFleet,
  subscribeSwarmRun,
  swarmRunSnapshot,
  type SwarmAgentLiveState,
} from "../lib/swarm-run-controller";
import styles from "./swarm-panel.module.css";

export const SWARM_PANEL_DEFAULT_WIDTH = 320;
export const SWARM_PANEL_MIN_WIDTH = 320;
export const SWARM_PANEL_MAX_WIDTH = 720;
const SWARM_PANEL_CHAT_RESERVE = 420;
const SWARM_PANEL_RESIZE_STEP = 16;
const SWARM_PANEL_RESIZE_STEP_LARGE = 40;

export function clampSwarmPanelWidth(width: number, viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth): number {
  const viewportMax = Math.max(
    SWARM_PANEL_MIN_WIDTH,
    Math.min(SWARM_PANEL_MAX_WIDTH, viewportWidth - SWARM_PANEL_CHAT_RESERVE),
  );
  return Math.round(Math.min(viewportMax, Math.max(SWARM_PANEL_MIN_WIDTH, width)));
}

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
  const reduceMotion = Boolean(useReducedMotion());
  return (
    <button className={styles.row} type="button" onClick={onOpen}>
      {live ? (
        <span className={styles.orb}>
          <ThinkingOrb
            state="shaping"
            size={20}
            paused={reduceMotion}
            aria-label={`${agent.title} is working`}
          />
        </span>
      ) : (
        <span
          className={`${styles.dot} ${agent.phase === "failed" ? styles.dotFailed : styles.dotDone}`}
          aria-hidden="true"
        />
      )}
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
  width,
  onWidthChange,
  onResizeActiveChange,
  onWidenPastDefault,
}: Readonly<{
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onResizeActiveChange?: (active: boolean) => void;
  onWidenPastDefault?: () => void;
}>): React.ReactNode {
  const snapshot = useSyncExternalStore(subscribeSwarmRun, swarmRunSnapshot, swarmRunSnapshot);
  const [inspectKey, setInspectKey] = useState<string | null>(null);
  const [inspectEvents, setInspectEvents] = useState<readonly TraceEvent[]>([]);
  const [inspectState, setInspectState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  const applyWidth = (nextWidth: number) => {
    const next = clampSwarmPanelWidth(nextWidth);
    onWidthChange(next);
    if (next > SWARM_PANEL_DEFAULT_WIDTH) onWidenPastDefault?.();
  };

  const setResizeActive = (active: boolean) => {
    setResizing(active);
    onResizeActiveChange?.(active);
  };

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
    };
    setResizeActive(true);
  };

  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyWidth(drag.startWidth + (drag.startX - event.clientX));
  };

  const onResizePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizeActive(false);
  };

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SWARM_PANEL_RESIZE_STEP_LARGE : SWARM_PANEL_RESIZE_STEP;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyWidth(widthRef.current + step);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      applyWidth(widthRef.current - step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      applyWidth(SWARM_PANEL_MIN_WIDTH);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      applyWidth(SWARM_PANEL_MAX_WIDTH);
    }
  };

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

  useEffect(() => {
    if (!resizing) return;
    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  return (
    <div className={`${styles.inner} ${resizing ? styles.innerResizing : ""}`}>
      <div
        className={styles.resizeHandle}
        role="slider"
        aria-orientation="vertical"
        aria-label="Resize swarm panel"
        aria-controls="analysis-takeaways"
        aria-valuemin={SWARM_PANEL_MIN_WIDTH}
        aria-valuemax={SWARM_PANEL_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onKeyDown={onResizeKeyDown}
      />
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
