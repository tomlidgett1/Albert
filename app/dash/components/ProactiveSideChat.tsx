"use client";

/**
 * The Proactive side chat (ADR 0113): a right-hand drawer that continues one
 * research agent's own codex conversation, so explore questions inherit the
 * agent's context and prior evidence. Streams /api/codex-conversation SSE and
 * renders turns with the production trace renderer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { TraceEvent } from "@/packages/shared/src";
import InsightsStyleTrace from "./InsightsStyleTrace";
import styles from "./proactive-workspace.module.css";

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

type SideChatTurn = Readonly<{
  id: string;
  userMessage: string;
  events: readonly TraceEvent[];
  streaming: boolean;
}>;

function mergeEvents(existing: readonly TraceEvent[], incoming: TraceEvent): readonly TraceEvent[] {
  if (existing.some((event) => event.id === incoming.id)) return existing;
  return [...existing, incoming].sort((left, right) => left.sequence - right.sequence);
}

export default function ProactiveSideChat({
  conversationId,
  title,
  initialQuestion,
  model,
  reasoningEffort,
  onClose,
}: Readonly<{
  /** Null starts a fresh codex conversation on the first question. */
  conversationId: string | null;
  title: string;
  initialQuestion: string | null;
  model: string;
  reasoningEffort: string;
  onClose: () => void;
}>) {
  const [turns, setTurns] = useState<readonly SideChatTurn[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">(
    conversationId ? "loading" : "ready",
  );
  const conversationIdRef = useRef<string | null>(conversationId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialSentRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null) as { history?: { turns?: unknown[] } } | null;
        if (!response.ok || !payload?.history || !Array.isArray(payload.history.turns)) {
          throw new Error("history unavailable");
        }
        if (cancelled) return;
        const restored: SideChatTurn[] = [];
        for (const raw of payload.history.turns) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const turn = raw as Record<string, unknown>;
          if (typeof turn.user_message !== "string" || typeof turn.turn_id !== "string" || !Array.isArray(turn.events)) continue;
          restored.push({
            id: turn.turn_id,
            userMessage: turn.user_message,
            events: turn.events
              .map(parseTraceEvent)
              .filter((event): event is TraceEvent => event !== null)
              .sort((left, right) => left.sequence - right.sequence),
            streaming: false,
          });
        }
        setTurns(restored);
        setHistoryState("ready");
      } catch {
        if (!cancelled) setHistoryState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const sendQuestion = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setSendError(null);
    const localId = `local-${Date.now()}`;
    setTurns((current) => [...current, { id: localId, userMessage: trimmed, events: [], streaming: true }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const activeConversationId = conversationIdRef.current;
      const response = await fetch("/api/codex-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          ...(activeConversationId ? { conversationId: activeConversationId } : {}),
          preferences: { model, reasoningEffort, fastMode: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "The question could not be sent.");
      }
      const startedConversationId = response.headers.get("X-Albert-Conversation-Id");
      if (startedConversationId) conversationIdRef.current = startedConversationId;
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
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (eventName !== "trace" || dataLines.length === 0) continue;
          let parsedEvent: TraceEvent | null = null;
          try {
            parsedEvent = parseTraceEvent(JSON.parse(dataLines.join("\n")));
          } catch {
            parsedEvent = null;
          }
          if (!parsedEvent) continue;
          const nextEvent = parsedEvent;
          setTurns((current) => current.map((turn) => turn.id === localId
            ? { ...turn, events: mergeEvents(turn.events, nextEvent) }
            : turn));
        }
        if (done) break;
      }
      setTurns((current) => current.map((turn) => turn.id === localId
        ? { ...turn, streaming: false }
        : turn));
    } catch (error) {
      if (!controller.signal.aborted) {
        setSendError(error instanceof Error ? error.message : "The question could not be sent.");
      }
      setTurns((current) => current.map((turn) => turn.id === localId
        ? { ...turn, streaming: false }
        : turn));
    } finally {
      setSending(false);
    }
  }, [model, reasoningEffort, sending]);

  useEffect(() => {
    if (historyState !== "ready" || initialSentRef.current) return;
    initialSentRef.current = true;
    if (!initialQuestion) return;
    // Deferred a frame so the send's state updates never land inside this
    // effect's own render pass.
    const frame = window.requestAnimationFrame(() => void sendQuestion(initialQuestion));
    return () => window.cancelAnimationFrame(frame);
  }, [historyState, initialQuestion, sendQuestion]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  return (
    <motion.aside
      className={styles.sideChat}
      role="dialog"
      aria-label={`Explore ${title}`}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
    >
      <header className={styles.sideChatHeader}>
        <div>
          <p className={styles.sideChatEyebrow}>Exploring</p>
          <h3 className={styles.sideChatTitle}>{title}</h3>
        </div>
        <button type="button" className={styles.popupClose} aria-label="Close side chat" onClick={onClose}>
          ×
        </button>
      </header>
      <div className={styles.sideChatBody} ref={scrollRef}>
        {historyState === "loading" ? (
          <p className={styles.sideChatState} role="status">Opening the agent&apos;s research…</p>
        ) : historyState === "error" ? (
          <p className={styles.sideChatState} role="alert">The research conversation could not be loaded.</p>
        ) : null}
        {turns.map((turn) => (
          <div className={styles.sideChatTurn} key={turn.id}>
            <div className={styles.sideChatUser}>{turn.userMessage}</div>
            <div className={styles.sideChatAssistant}>
              <InsightsStyleTrace
                events={turn.events}
                streaming={turn.streaming}
                runtime="codex"
                onFollowUp={(prompt) => void sendQuestion(prompt)}
              />
            </div>
          </div>
        ))}
        {sendError ? <p className={styles.sideChatState} role="alert">{sendError}</p> : null}
      </div>
      <form
        className={styles.sideChatComposer}
        onSubmit={(event) => {
          event.preventDefault();
          const question = draft;
          setDraft("");
          void sendQuestion(question);
        }}
      >
        <input
          className={styles.sideChatInput}
          value={draft}
          placeholder={sending ? "Albert is answering…" : "Ask about this area…"}
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Ask about this area"
        />
        <button type="submit" className={styles.sideChatSend} disabled={sending || !draft.trim()}>
          Ask
        </button>
      </form>
    </motion.aside>
  );
}
