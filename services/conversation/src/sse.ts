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
