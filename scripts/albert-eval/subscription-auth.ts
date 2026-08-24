import path from "node:path";
import type { CodexAppServerAuthentication } from "../../packages/albert-codex/src/app-server.js";

/**
 * Reviewed 2026-08-24: the file contains only the user's global quality
 * instruction. Binding its exact bytes avoids accepting arbitrary home-level
 * prompt material while Codex owns the adjacent subscription auth state.
 */
const REVIEWED_HOME_AGENTS_SHA256 = "49ac8af0c0cfa662c4159b348d59d80774b0b5cc8f3d9bfe446c99a7848c6aa6";

export function subscriptionAuthentication(codexHome: string): CodexAppServerAuthentication {
  return Object.freeze({
    mode: "chatgpt",
    codexHome,
    reviewedInstructionSources: Object.freeze([Object.freeze({
      path: path.join(codexHome, "AGENTS.md"),
      sha256: REVIEWED_HOME_AGENTS_SHA256,
    })]),
  });
}
