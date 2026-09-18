import { OAI_CODEX_ROUTE_PROFILE, handleOmniHarnessConversation } from "../omni-conversation/harness-route";

export const maxDuration = 800;
// Pinned to Sydney in vercel.json like the Omni route: the control plane,
// the agent runtime on Fly and Cube all live there.

/**
 * OAI Codex (ADR 0141): the same governed tools and answer contract as
 * Omni, driven by OpenAI's managed Codex harness through the Agents API.
 */
export async function POST(request: Request): Promise<Response> {
  return handleOmniHarnessConversation(request, OAI_CODEX_ROUTE_PROFILE);
}
