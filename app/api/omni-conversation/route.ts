import { OMNI_ROUTE_PROFILE, handleOmniHarnessConversation } from "./harness-route";

export const maxDuration = 800;
// This route's function region is pinned to Sydney in vercel.json (the
// `preferredRegion` export is deprecated in Next 16 and ignored): every
// service it talks to (control-plane Supabase, the agent runtime on Fly,
// Cube) lives there, and the platform default put the function in US-east.

/** Omni: the in-process agent loop over Albert's governed tools. */
export async function POST(request: Request): Promise<Response> {
  return handleOmniHarnessConversation(request, OMNI_ROUTE_PROFILE);
}
