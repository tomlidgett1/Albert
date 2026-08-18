import { z } from "zod";
import {
  consumeAlbertRateLimit,
  currentTenantContext,
  isFivetranConnection,
  requireUser,
  ControlPlaneError,
} from "@/services/control-plane/src/web-repository";
import { OAuthFlowError, fivetranXeroSyncStatus } from "@/services/oauth/src/worker-rpc";
import { rateLimitExceededResponse } from "@/services/control-plane/src/request-security";

const querySchema = z.object({
  connectionId: z.string().trim().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
});

/**
 * Live readout for a Fivetran-managed Xero connection: Fivetran's own sync
 * phase plus what has actually landed in the tenant's schema. Read-only, so
 * it is a GET; the worker enforces tenant + owner/manager membership again
 * before it touches Fivetran or the analytical database.
 */
export async function GET(request: Request) {
  try {
    const tenant = await currentTenantContext();
    if (!tenant) {
      return Response.json({ error: "Organisation context is required." }, { status: 409 });
    }
    const limit = await consumeAlbertRateLimit("connection.fivetran_status");
    if (!limit.allowed) return rateLimitExceededResponse(limit);

    const parsed = querySchema.safeParse({
      connectionId: new URL(request.url).searchParams.get("connectionId") ?? "",
    });
    if (!parsed.success) {
      return Response.json({ error: "A valid connection id is required." }, { status: 400 });
    }
    const { supabase, user } = await requireUser();
    if (!(await isFivetranConnection(parsed.data.connectionId, supabase))) {
      return Response.json({ error: "That connection is not managed by Fivetran." }, { status: 404 });
    }
    const status = await fivetranXeroSyncStatus({
      tenantId: tenant.tenant_id,
      userId: user.id,
      connectionId: parsed.data.connectionId,
    });
    return Response.json(status, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const status = error instanceof OAuthFlowError ? error.status : 502;
    return Response.json(
      { error: "The sync status is unavailable right now." },
      { status: status === 403 || status === 404 || status === 409 ? status : 502 },
    );
  }
}
