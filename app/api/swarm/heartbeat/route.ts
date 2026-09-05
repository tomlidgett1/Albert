import { z } from "zod";
import { loadSwarmRun } from "@/services/control-plane/src/swarm-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { renewConversationTurnLease } from "@/services/conversation/src/artifact-store";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";

const bodySchema = z.object({
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
}).strict();

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOriginMutation(request);
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) {
      return Response.json({ error: "Create your organisation before using Swarm." }, { status: 409 });
    }
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const run = await loadSwarmRun(parsed.runId);
    if (run.status !== "running" && run.status !== "synthesising") {
      return Response.json({ ok: true, status: run.status });
    }
    const renewed = await renewConversationTurnLease({
      supabase: auth.supabase,
      turnId: run.parentTurnId,
      leaseSeconds: 360,
    });
    return Response.json({ ok: renewed });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Invalid swarm heartbeat." }, { status: 400 });
    }
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({ error: "The swarm lease could not be renewed." }, { status });
  }
}
