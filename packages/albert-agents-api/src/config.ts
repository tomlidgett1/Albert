import type { AgentRunPreferences } from "../../shared/src/agent-runtime.js";

export const AGENTS_API_RUNTIME = "openai-agents-api" as const;
export const AGENTS_API_MODEL_IDS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as const;
export const DEFAULT_AGENTS_API_PREFERENCES: AgentRunPreferences = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "high",
  fastMode: false,
});
