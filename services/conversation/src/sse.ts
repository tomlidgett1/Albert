import {
  assertOrderedSanitizedTrace,
  type TraceEvent,
} from "../../../packages/shared/src/index.js";

const encoder = new TextEncoder();

export type TraceSseOptions = Readonly<{
  /** Delay between fixture events. Production streams normally omit this. */
  intervalMs?: number;
  signal?: AbortSignal;
}>;

export function encodeTraceSseEvent(event: TraceEvent): string {
  return `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`;
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Streams already-sanitized public trace events. This transport never accepts
 * provider events directly; callers must map them into `TraceEvent` first.
 */
export function createTraceSseResponse(
  events: readonly TraceEvent[],
  options: TraceSseOptions = {},
): Response {
  const validatedEvents = assertOrderedSanitizedTrace(events);
  const intervalMs = Math.max(0, options.intervalMs ?? 0);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const event of validatedEvents) {
          if (options.signal?.aborted) break;
          controller.enqueue(encoder.encode(encodeTraceSseEvent(event)));
          await wait(intervalMs);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

export type LiveTraceSseOptions = Readonly<{
  conversationId: string;
  signal?: AbortSignal;
  run: (emit: (event: TraceEvent) => void, signal: AbortSignal) => Promise<void>;
}>;

/** Streams product trace events as they are persisted by the live runtime. */
export function createLiveTraceSseResponse(options: LiveTraceSseOptions): Response {
  const runAbort = new AbortController();
  const abortRun = () => runAbort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortRun, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      const heartbeat = setInterval(() => {
        if (!closed && !runAbort.signal.aborted) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);
      const abort = () => close();
      runAbort.signal.addEventListener("abort", abort, { once: true });

      void options.run((event) => {
        if (!closed && !runAbort.signal.aborted) {
          controller.enqueue(encoder.encode(encodeTraceSseEvent(event)));
        }
      }, runAbort.signal).then(close).catch((error) => {
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      }).finally(() => {
        clearInterval(heartbeat);
        runAbort.signal.removeEventListener("abort", abort);
        options.signal?.removeEventListener("abort", abortRun);
      });
    },
    cancel(reason) {
      runAbort.abort(reason);
      options.signal?.removeEventListener("abort", abortRun);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Albert-Conversation-Id": options.conversationId,
    },
  });
}
