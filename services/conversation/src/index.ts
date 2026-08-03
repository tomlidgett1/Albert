import { createDeterministicFixtureTrace } from "./fixture.js";
import { createTraceSseResponse, type TraceSseOptions } from "./sse.js";

export * from "./fixture.js";
export * from "./sse.js";
export * from "./live.js";
export * from "./semantic-adapter.js";
export * from "./semantic-client.js";

/** Ready-to-mount fixture handler for an authenticated development route. */
export function createFixtureConversationSseResponse(
  options: TraceSseOptions = {},
): Response {
  return createTraceSseResponse(createDeterministicFixtureTrace(), options);
}
