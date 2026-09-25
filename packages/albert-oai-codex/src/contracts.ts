import type { AlbertModelId } from "../../shared/src/agent-runtime.js";

/**
 * OAI Codex (ADR 0141): the Omni analyst's governed tools and answer
 * contract, driven by OpenAI's managed Codex harness through the Agents API
 * instead of the in-process `@openai/agents` loop.
 */
export const ALBERT_OAI_CODEX_HARNESS = "oai-codex" as const;
export const ALBERT_OAI_CODEX_RUNTIME = "oai-codex-agent" as const;
export const ALBERT_OAI_CODEX_ANALYTICAL_RUNTIME = "cube-oai-codex-v1" as const;
/** The value of `X-Albert-Runtime` on the conversation stream. */
export const ALBERT_OAI_CODEX_RUNTIME_HEADER = "oai_codex" as const;
/**
 * The managed harness runs OpenAI models only: GPT-6 on the global host
 * (ADR 0145), with retired GPT-5.6 still admitted on the regional one.
 */
export const ALBERT_OAI_CODEX_MODEL_IDS = [
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const satisfies readonly AlbertModelId[];
export const ALBERT_OAI_CODEX_DEFAULT_MODEL = "gpt-6-luna" as const;
export const ALBERT_OAI_CODEX_DEFAULT_EFFORT = "max" as const;
export const ALBERT_OAI_CODEX_DEFAULT_FAST_MODE = false as const;
