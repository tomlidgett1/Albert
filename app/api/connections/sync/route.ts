import { z } from "zod";
import { createClient } from "@/utils/supabase/server";
import {
  consumeAlbertRateLimit,
  currentTenantContext,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

const requestSchema = z
  .object({ connectionId: z.string().trim().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u) })
  .strict();

/**
 * Reasons the definer may decline, mapped to copy an owner can act on. The
 * function returns a code rather than prose so the boundary owns the wording
 * and the database never emits user-facing text.
 */
const DECLINE_COPY: Readonly<Record<string, { status: number; message: string }>> = {
  invalid_connection_id: { status: 400, message: "That connection is invalid." },
  no_active_organisation: { status: 409, message: "Select an organisation before syncing." },
  insufficient_role: { status: 403, message: "Owner or manager access is required to sync." },
  connection_not_found: { status: 404, message: "That connection is no longer available." },
  connection_not_connected: {
    status: 409,
    message: "Reconnect this integration before syncing.",
  },
  reauthorisation_required: {
    status: 409,
    message: "Reconnect this integration before starting ingestion.",
  },
  account_not_selected: {
    status: 409,
    message: "Choose which account to sync before starting.",
  },
  ingestion_blocked: {
    status: 409,
    message: "Ingestion is temporarily unavailable for this connection.",
  },
  sync_already_running: {
    status: 200,
    message: "A sync is already running for this connection.",
  },
};

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);

    const tenant = await currentTenantContext();
    if (!tenant) {
      return Response.json({ error: "Organisation context is required." }, { status: 409 });
    }
    if (!["owner", "manager"].includes(tenant.role)) {
      return Response.json({ error: "Owner or manager access is required." }, { status: 403 });
    }

    // A backfill is expensive and vendor-rate-limited, so the request is capped
    // well below anything a frustrated click could produce.
    const limit = await consumeAlbertRateLimit("connection.manual_sync");
    if (!limit.allowed) return rateLimitExceededResponse(limit);

    const body = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) {
      return Response.json({ error: "A valid connection id is required." }, { status: 400 });
    }

    // Tenant scope is enforced inside the definer against the session, never
    // from this body: a connection id belonging to another tenant reads as absent.
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("albert_request_manual_sync", {
      p_connection_id: body.data.connectionId,
    });

    if (error) {
      return Response.json({ error: "Could not start the sync." }, { status: 502 });
    }

    const outcome = Array.isArray(data) ? data[0] : data;
    if (!outcome?.accepted) {
      const decline = DECLINE_COPY[String(outcome?.reason ?? "")] ?? {
        status: 409,
        message: "Could not start the sync.",
      };
      return Response.json(
        { accepted: false, reason: outcome?.reason ?? "unknown", message: decline.message },
        { status: decline.status },
      );
    }

    return Response.json({ accepted: true, syncRunId: outcome.sync_run_id }, { status: 202 });
  } catch (cause) {
    if (cause instanceof Response) return cause;
    return Response.json({ error: "Could not start the sync." }, { status: 500 });
  }
}
