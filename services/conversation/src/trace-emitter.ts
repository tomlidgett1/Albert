import { ulid } from "ulid";
import { assertOrderedSanitizedTrace, type TraceEvent } from "../../../packages/shared/src/index.js";

type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, "id" | "sequence" | "occurredAt">
    : never
  : never;

/** Outcome of the queued trace writes, reported once the queue is drained. */
export type TracePersistenceSummary = Readonly<{ persisted: number; failed: number }>;

export type EmitTrace = ((event: TraceEventInput) => Promise<TraceEvent>) & Readonly<{
  /**
   * Awaits every queued persistence write. Callers must await this before any
   * step that reads the persisted trace back. Emitters that persist inline
   * leave it undefined.
   */
  drain?: () => Promise<TracePersistenceSummary>;
}>;

export function createTraceEmitter(options: Readonly<{
  persist: (event: TraceEvent) => Promise<void>;
  deliver: (event: TraceEvent) => void;
  /** Reports a write that failed after its event had already been delivered. */
  onPersistError?: (error: unknown, event: TraceEvent) => void;
}>): EmitTrace {
  const events: TraceEvent[] = [];
  // Writes are chained rather than awaited inline. A trace event records
  // something that has already happened, so blocking the turn on its round
  // trip only adds latency to every tool step; chaining keeps the writes
  // strictly ordered while they overlap the model's own thinking time.
  let queue: Promise<void> = Promise.resolve();
  let persisted = 0;
  let failed = 0;

  const emit = (async (partial: TraceEventInput) => {
    const event = {
      ...partial,
      id: ulid(),
      sequence: events.length + 1,
      occurredAt: new Date().toISOString(),
    } as TraceEvent;
    // Identity, ordering and validation stay synchronous, so a delivered event
    // is as well-formed and as well-ordered as it was when the write blocked.
    assertOrderedSanitizedTrace([...events, event]);
    events.push(event);
    queue = queue.then(async () => {
      try {
        await options.persist(event);
        persisted += 1;
      } catch (error) {
        // The browser is never left with an empty trace when persistence is
        // temporarily unavailable, and the turn continues so Albert can still
        // return a terminal answer.
        failed += 1;
        options.onPersistError?.(error, event);
      }
    });
    options.deliver(event);
    return event;
  }) as EmitTrace & { drain: () => Promise<TracePersistenceSummary> };

  return Object.assign(emit, {
    drain: async (): Promise<TracePersistenceSummary> => {
      // An event emitted while draining chains onto a new tail, so join until
      // the tail stops moving rather than only awaiting the tail we found.
      let pending = queue;
      for (;;) {
        await pending;
        if (pending === queue) break;
        pending = queue;
      }
      return Object.freeze({ persisted, failed });
    },
  });
}
