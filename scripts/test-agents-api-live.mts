import assert from "node:assert/strict";
import { tool, user } from "@openai/agents";
import { z } from "zod";
import { ManagedAgentsHarness } from "../packages/albert-agents-api/src/harness.js";
import { DEFAULT_AGENTS_API_PREFERENCES } from "../packages/albert-agents-api/src/config.js";

// Synthetic data only. Uses the configured application key without printing it.
const apiKey = process.env.OPENAI_API_KEY;
assert.ok(apiKey, "OPENAI_API_KEY must be configured in the environment.");
const harness = new ManagedAgentsHarness({ apiKey });
let toolCalls = 0;
const syntheticTotal = tool({
  name: "SyntheticTotal",
  description: "Return the recorded total for a synthetic test fixture. No live business data is involved.",
  parameters: z.object({ fixture: z.enum(["first", "second"]) }).strict(),
  execute: async ({ fixture }) => { toolCalls += 1; return JSON.stringify({ total: fixture === "first" ? 42 : 73 }); },
});
const input = [user("Fetch the first fixture total and tell me its value.")];
try {
  const first = await harness.run({
    instructions: "Use SyntheticTotal to fetch each requested fixture. Reply with its recorded total. Do not calculate or invent a total.",
    tools: [syntheticTotal], input,
    preferences: { ...DEFAULT_AGENTS_API_PREFERENCES, reasoningEffort: "low" },
    signal: AbortSignal.timeout(120_000),
  });
  assert.match(first.text, /\b42\b/u);
  assert.equal(toolCalls, 1);
  console.log("PASS: live Agents API creates a session, calls an application tool, and returns its result.");
  input.push(user("Now fetch the second fixture. State both the earlier total and this new total."));
  const second = await harness.run({
    instructions: "Use SyntheticTotal for requested fixtures.", tools: [syntheticTotal], input,
    preferences: { ...DEFAULT_AGENTS_API_PREFERENCES, reasoningEffort: "low" }, signal: AbortSignal.timeout(120_000),
  });
  assert.match(second.text, /\b42\b/u);
  assert.match(second.text, /\b73\b/u);
  assert.ok(toolCalls >= 2);
  console.log("PASS: follow-up retains session context and executes the next tool.");
} finally {
  await harness.close();
  console.log("PASS: temporary Agents API session deleted.");
}
