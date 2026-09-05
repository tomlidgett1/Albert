import type { TraceEvent } from "@/packages/shared/src";

const traceEventTypes = new Set([
  "progress", "narrative", "plan", "query", "table", "chart",
  "validation", "answer", "clarification", "tasks", "research", "error",
]);

export type NewTestTurn = Readonly<{
  id: string;
  userMessage: string;
  events: readonly TraceEvent[];
  streaming: boolean;
}>;

export type NewTestChatSnapshot = Readonly<{
  turns: readonly NewTestTurn[];
  sending: boolean;
  sendError: string | null;
}>;

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

function mergeEvents(existing: readonly TraceEvent[], incoming: TraceEvent): readonly TraceEvent[] {
  if (existing.some((event) => event.id === incoming.id)) return existing;
  return [...existing, incoming].sort((left, right) => left.sequence - right.sequence);
}

let conversationId: string | null = null;
let abortController: AbortController | null = null;
let snapshot: NewTestChatSnapshot = {
  turns: [],
  sending: false,
  sendError: null,
};
const listeners = new Set<() => void>();

function emit(next: NewTestChatSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeNewTestChat(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNewTestChatSnapshot() {
  return snapshot;
}

export async function sendNewTestQuestion(question: string) {
  const trimmed = question.trim();
  if (!trimmed || snapshot.sending) return;
  const localId = `local-${Date.now()}`;
  emit({
    turns: [...snapshot.turns, { id: localId, userMessage: trimmed, events: [], streaming: true }],
    sending: true,
    sendError: null,
  });
  const controller = new AbortController();
  abortController = controller;
  try {
    const response = await fetch("/api/codex-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: trimmed,
        ...(conversationId ? { conversationId } : {}),
        preferences: { fastMode: true },
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || "The question could not be sent.");
    }
    const startedConversationId = response.headers.get("X-Albert-Conversation-Id");
    if (startedConversationId) conversationId = startedConversationId;
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
        emit({
          ...snapshot,
          turns: snapshot.turns.map((turn) => turn.id === localId
            ? { ...turn, events: mergeEvents(turn.events, nextEvent) }
            : turn),
        });
      }
      if (done) break;
    }
    emit({
      ...snapshot,
      sending: false,
      turns: snapshot.turns.map((turn) => (
        turn.id === localId ? { ...turn, streaming: false } : turn
      )),
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      emit({
        sending: false,
        sendError: error instanceof Error ? error.message : "The question could not be sent.",
        turns: snapshot.turns.map((turn) => (
          turn.id === localId ? { ...turn, streaming: false } : turn
        )),
      });
      return;
    }
    emit({
      ...snapshot,
      sending: false,
      turns: snapshot.turns.map((turn) => (
        turn.id === localId ? { ...turn, streaming: false } : turn
      )),
    });
  } finally {
    if (abortController === controller) abortController = null;
  }
}
