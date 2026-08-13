import { createDeterministicFixtureTrace } from "./fixture.js";
import { createTraceSseResponse, type TraceSseOptions } from "./sse.js";

export * from "./fixture.js";
export * from "./sse.js";
export * from "./trace-emitter.js";
export * from "./prompt-routing.js";
export * from "./claims.js";
export * from "./usage-lifecycle.js";
export * from "./conversation-title.js";

/** Ready-to-mount fixture handler for an authenticated development route. */
export function createFixtureConversationSseResponse(
  options: TraceSseOptions = {},
): Response {
  return createTraceSseResponse(createDeterministicFixtureTrace(), options);
}
