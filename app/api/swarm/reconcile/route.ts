/**
 * Reconcile a stranded Swarm run (ADR 0120 update).
 *
 * The fleet is browser-orchestrated, so a closed tab leaves the run and its
 * agents 'running' with nobody to settle them. POST { runId } asks the
 * control plane to settle such a run. The RPC is gated on the parent turn's
 * lease — a live orchestrator keeps renewing it — so reconciling a run that
 * is still being driven anywhere is a safe no-op.
 */
import { z } from "zod";
import { reconcileSwarmRun } from "@/services/control-plane/src/swarm-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-swarm-web");
const bodySchema = z.object({
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) {
      return Response.json({ error: "Create your organisation before using Swarm." }, {
        status: 409,
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const result = await reconcileSwarmRun(parsed.runId);
    if (result.reconciled) {
      logger.info("swarm.run_reconciled", {
        tenantId: tenant.tenant_id,
        runId: parsed.runId,
        status: result.run.status,
      }, correlationId);
    }
    return Response.json({ run: result.run, reconciled: result.reconciled }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Invalid swarm reconcile request." }, {
        status: 400,
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }
    logger.error("swarm.reconcile_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({
      error: error instanceof ControlPlaneError ? error.message : "The swarm could not be reconciled.",
    }, {
      status,
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  }
}
