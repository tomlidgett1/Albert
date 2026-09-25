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

const requestSchema = z.object({
  connectionId: z.string().trim().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
}).strict();

const DECLINE_COPY: Readonly<Record<string, { status: number; message: string }>> = {
  invalid_connection_id: { status: 400, message: "That connection is invalid." },
  no_active_organisation: { status: 409, message: "Select an organisation before starting ingestion." },
  insufficient_role: { status: 403, message: "Owner or manager access is required to start ingestion." },
  connection_not_found: { status: 404, message: "That connection is no longer available." },
  connection_not_connected: { status: 409, message: "Reconnect this integration before starting ingestion." },
  reauthorisation_required: { status: 409, message: "Refresh authorization before starting ingestion." },
  account_not_selected: { status: 409, message: "Choose which account to ingest before starting." },
  operator_blocked: {
    status: 409,
    message: "Ingestion is not available for this connection yet. Contact support.",
  },
  shopify_deletion_continuity_unproven: {
    status: 409,
    message: "Shopify deletion history cannot be proven. Disconnect this store, wait for verified local deletion to complete, reconnect it, then start ingestion.",
  },
  shopify_deletion_watermark_missing: {
    status: 409,
    message: "Shopify deletion history cannot be proven. Disconnect this store, wait for verified local deletion to complete, reconnect it, then start ingestion.",
  },
  shopify_deletion_retention_gap: {
    status: 409,
    message: "Shopify deletion history cannot be proven. Disconnect this store, wait for verified local deletion to complete, reconnect it, then start ingestion.",
  },
  shopify_deletion_feed_unavailable: {
    status: 409,
    message: "Shopify's deletion feed could not be verified. Disconnect this store, wait for verified local deletion to complete, reconnect it, then start ingestion.",
  },
  manual_start_not_required: { status: 409, message: "This connection starts ingestion automatically." },
  ingestion_already_started: { status: 200, message: "Ingestion has already started for this connection." },
  initial_start_failed: {
    status: 409,
    message: "The first ingestion attempt needs attention. Try Sync now or contact support.",
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
      return Response.json(
        { error: "Owner or manager access is required to start ingestion." },
        { status: 403 },
      );
    }

    const limit = await consumeAlbertRateLimit("connection.start_ingestion");
    if (!limit.allowed) return rateLimitExceededResponse(limit);

    const body = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) {
      return Response.json({ error: "A valid connection id is required." }, { status: 400 });
    }

    // The definer derives tenant and actor from the authenticated session. No
    // browser-provided scope or role reaches the queue boundary.
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("albert_start_connection_ingestion", {
      p_connection_id: body.data.connectionId,
    });
    if (error) {
      return Response.json({ error: "Could not start ingestion." }, { status: 502 });
    }

    const outcome = Array.isArray(data) ? data[0] : data;
    if (!outcome?.accepted) {
      const reason = String(outcome?.reason ?? "unknown");
      const decline = DECLINE_COPY[reason] ?? {
        status: 409,
        message: "Could not start ingestion.",
      };
      return Response.json(
        { accepted: false, reason, message: decline.message },
        { status: decline.status },
      );
    }

    return Response.json({
      accepted: true,
      syncRunId: outcome.sync_run_id,
      jobRequestId: outcome.job_request_id,
    }, { status: 202 });
  } catch (cause) {
    if (cause instanceof Response) return cause;
    return Response.json({ error: "Could not start ingestion." }, { status: 500 });
  }
}
