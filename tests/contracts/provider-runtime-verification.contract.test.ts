import assert from "node:assert/strict";
import test from "node:test";

import { verifyOpenAIProviderRuntime } from "../../services/conversation/src/provider-runtime-verification.js";

const requirement = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  reasoningMode: "standard" as const,
  serviceTier: "default" as const,
});

function response(overrides: Record<string, unknown> = {}) {
  return {
    providerData: {
      model: "gpt-5.6-luna",
      service_tier: "default",
      reasoning: {
        effort: "max",
        mode: "standard",
      },
      ...overrides,
    },
  };
}

test("provider runtime receipt proves every response used Luna Max standard non-Fast", () => {
  assert.deepEqual(
    verifyOpenAIProviderRuntime([response(), response()], requirement),
    {
      ...requirement,
      responseCount: 2,
      verified: true,
    },
  );
});

test("provider runtime verification rejects aliases, wrong tiers, Pro, and absent evidence", () => {
  assert.throws(
    () =>
      verifyOpenAIProviderRuntime(
        [response({ model: "gpt-5.6" })],
        requirement,
      ),
    /required model/u,
  );
  assert.throws(
    () =>
      verifyOpenAIProviderRuntime(
        [response({ service_tier: "priority" })],
        requirement,
      ),
    /required processing tier/u,
  );
  assert.throws(
    () =>
      verifyOpenAIProviderRuntime(
        [response({ reasoning: { effort: "max", mode: "pro" } })],
        requirement,
      ),
    /required reasoning mode/u,
  );
  assert.throws(
    () => verifyOpenAIProviderRuntime([{ providerData: {} }], requirement),
    /did not expose effective runtime settings/u,
  );
});
