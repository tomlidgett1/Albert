import { z } from "zod";
import { ControlPlaneError, requireUser } from "./web-repository.js";

/**
 * Partner semantic query leases (ADR 0153, migration 0196). A lease is the
 * execution claim Cube's driver trades for a semantic_read capability; the
 * claim RPC returns the member's live lease while it has time left, so one
 * lease serves a burst of dashboard queries.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

const leaseSchema = z.object({
  leaseId: z.string().regex(ULID),
  tenantId: z.string().regex(ULID),
  role: z.enum(["owner", "manager"]),
  expiresAt: z.string().min(1),
}).strict();

export type SemanticQueryLease = z.infer<typeof leaseSchema>;

export async function claimSemanticQueryLease(
  expectedTenantId: string,
  purpose: string,
): Promise<SemanticQueryLease> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_semantic_query_lease_claim", {
    p_expected_tenant_id: expectedTenantId,
    p_purpose: purpose,
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The semantic query migration is not deployed.", 503);
    }
    if (error.code === "AL409") throw new ControlPlaneError("This session belongs to another organisation.", 409);
    if (error.code === "P0002") throw new ControlPlaneError("Organisation context is required.", 409);
    if (error.code === "42501") throw new ControlPlaneError("Owner or manager access is required.", 403);
    if (error.code === "53400") throw new ControlPlaneError("Too many queries are running. Try again shortly.", 429);
    if (error.code === "22023") throw new ControlPlaneError("The query purpose is invalid.", 400);
    throw new ControlPlaneError("The query could not be started.", 503);
  }
  const parsed = leaseSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("The query lease returned an invalid shape.", 503);
  if (parsed.data.tenantId !== expectedTenantId) {
    throw new ControlPlaneError("This session belongs to another organisation.", 409);
  }
  return parsed.data;
}
