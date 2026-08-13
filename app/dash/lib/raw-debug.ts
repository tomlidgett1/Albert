import type { TraceEvent } from "@/packages/shared/src";

/**
 * Development-only capture of everything the browser observes for one turn:
 * the request it sent, the response headers it got back, every raw SSE frame,
 * and the parsed trace event each frame carried. It records only what this
 * client already holds — it never asks the server for private reasoning,
 * prompts, or compiled SQL, which the governed trace deliberately excludes.
 */
export type RawDebugEntryKind =
  | "request"
  | "response"
  | "frame"
  | "event"
  | "dropped"
  | "note"
  | "error"
  | "done";

export type RawDebugEntry = Readonly<{
  seq: number;
  /** Milliseconds since the request was sent. */
  atMs: number;
  /** Milliseconds since the previous entry. */
  deltaMs: number;
  kind: RawDebugEntryKind;
  label: string;
  /** The server's own emit timestamp, so server gaps can be read against arrival gaps. */
  serverAt?: string;
  bytes?: number;
  raw?: string;
  data?: unknown;
}>;

export type RawDebugStatus = "streaming" | "complete" | "stopped" | "error";

export type RawDebugTurn = Readonly<{
  id: string;
  prompt: string;
  startedAt: string;
  status: RawDebugStatus;
  runtime?: string;
  conversationId?: string;
  turnId?: string;
  httpStatus?: number;
  /** Time to first streamed frame. */
  ttfbMs?: number;
  durationMs?: number;
  eventCounts: Readonly<Record<string, number>>;
  entries: readonly RawDebugEntry[];
  /** Accepted trace events in arrival order; the Simple view is derived from these. */
  events: readonly TraceEvent[];
}>;

export type RawDebugRecorder = Readonly<{
  id: string;
  enabled: boolean;
  request: (url: string, body: unknown) => void;
  response: (response: Response, meta: Readonly<{ runtime: string; conversationId: string | null; turnId: string | null }>) => void;
  frame: (raw: string) => void;
  event: (event: TraceEvent) => void;
  dropped: (reason: string, raw: string) => void;
  note: (label: string, data?: unknown) => void;
  failed: (error: unknown) => void;
  finish: (status: RawDebugStatus) => void;
}>;

/** Response headers are the app's own; nothing here carries a credential. */
function headerMap(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return headers;
}

function summarizeEvent(event: TraceEvent): string {
  const detail = (() => {
    switch (event.type) {
      case "progress":
        return [event.stage, event.label].filter(Boolean).join(" · ");
      case "narrative":
        return event.text;
      case "plan":
        return event.steps.map((step) => `${step.status === "done" ? "✓" : step.status === "active" ? "▸" : "○"} ${step.label}`).join(" · ");
      case "query":
        return `${event.topic} · ${event.metrics.length} metric(s) · ${event.dimensions.length} dimension(s)`;
      case "table":
        return `${event.caption} · ${event.rows.length} row(s) × ${event.columns.length} col(s)`;
      case "chart":
        return `${event.chartType} · ${event.caption}`;
      case "validation":
        return `${event.name} · ${event.outcome}`;
      case "answer":
        return `${event.state} · ${event.followUps.length} follow-up(s)`;
      case "clarification":
        return event.question;
      case "error":
        return event.message;
      default:
        return "";
    }
  })();
  return `#${event.sequence} ${event.type}${detail ? ` — ${detail}` : ""}`;
}

const NO_OP_RECORDER: RawDebugRecorder = Object.freeze({
  id: "",
  enabled: false,
  request: () => undefined,
  response: () => undefined,
  frame: () => undefined,
  event: () => undefined,
  dropped: () => undefined,
  note: () => undefined,
  failed: () => undefined,
  finish: () => undefined,
});

export function createRawDebugRecorder(
  options: Readonly<{
    enabled: boolean;
    id: string;
    prompt: string;
    onUpdate: (turn: RawDebugTurn) => void;
  }>,
): RawDebugRecorder {
  if (!options.enabled) return NO_OP_RECORDER;

  const startedAtMs = performance.now();
  let turn: RawDebugTurn = {
    id: options.id,
    prompt: options.prompt,
    startedAt: new Date().toISOString(),
    status: "streaming",
    eventCounts: {},
    entries: [],
    events: [],
  };
  let lastAtMs = 0;

  const push = (
    kind: RawDebugEntryKind,
    label: string,
    extra: Partial<RawDebugEntry> = {},
    patch: Partial<RawDebugTurn> = {},
  ) => {
    const atMs = Math.round(performance.now() - startedAtMs);
    const entry: RawDebugEntry = {
      seq: turn.entries.length + 1,
      atMs,
      deltaMs: atMs - lastAtMs,
      kind,
      label,
      ...extra,
    };
    lastAtMs = atMs;
    turn = { ...turn, ...patch, entries: [...turn.entries, entry] };
    options.onUpdate(turn);
  };

  return Object.freeze({
    id: options.id,
    enabled: true,
    request: (url, body) => {
      push("request", `POST ${url}`, { data: body });
    },
    response: (response, meta) => {
      push(
        "response",
        `${response.status} ${response.statusText || "OK"} · ${meta.runtime}`,
        { data: { status: response.status, ok: response.ok, headers: headerMap(response) } },
        {
          httpStatus: response.status,
          runtime: meta.runtime,
          ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
          ...(meta.turnId ? { turnId: meta.turnId } : {}),
        },
      );
    },
    frame: (raw) => {
      const bytes = new TextEncoder().encode(raw).length;
      push(
        "frame",
        `SSE frame · ${bytes} bytes`,
        { bytes, raw },
        turn.ttfbMs === undefined
          ? { ttfbMs: Math.round(performance.now() - startedAtMs) }
          : {},
      );
    },
    event: (event) => {
      push(
        "event",
        summarizeEvent(event),
        { data: event, serverAt: event.occurredAt },
        {
          events: [...turn.events, event],
          eventCounts: {
            ...turn.eventCounts,
            [event.type]: (turn.eventCounts[event.type] ?? 0) + 1,
          },
        },
      );
    },
    dropped: (reason, raw) => {
      push("dropped", `Dropped frame · ${reason}`, { raw });
    },
    note: (label, data) => {
      push("note", label, data === undefined ? {} : { data });
    },
    failed: (error) => {
      push(
        "error",
        error instanceof Error ? error.message : String(error),
        { data: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error },
        { status: "error" },
      );
    },
    finish: (status) => {
      push(
        "done",
        `Stream ${status}`,
        {},
        { status, durationMs: Math.round(performance.now() - startedAtMs) },
      );
    },
  });
}

/** Bounded history so a long dev session cannot grow without limit. */
export const RAW_DEBUG_TURN_LIMIT = 8;

export function mergeRawDebugTurn(
  turns: readonly RawDebugTurn[],
  next: RawDebugTurn,
): RawDebugTurn[] {
  const without = turns.filter((turn) => turn.id !== next.id);
  return [next, ...without].slice(0, RAW_DEBUG_TURN_LIMIT);
}
