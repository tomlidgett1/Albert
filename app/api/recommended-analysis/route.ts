/** Seven-day investigations refreshed every 24 hours (ADR 0138); generation belongs to the worker. */
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import { ControlPlaneError, currentTenantContext, loadConnectorRouting, requireUser } from "@/services/control-plane/src/web-repository";
import { loadRecommendedAnalysisCache } from "@/services/control-plane/src/recommended-analysis-repository";
import { homepageDailyBrief } from "@/services/recommended-analysis/src/homepage-brief";

export const maxDuration = 30;
const logger = createServiceLogger("albert-recommended-analysis-web");

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  const headers = { "Cache-Control": "no-store", "x-request-id": correlationId };
  try {
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) throw new ControlPlaneError("Create your organisation before using Albert.", 409);
    const [cache, routing] = await Promise.all([
      loadRecommendedAnalysisCache(auth.supabase),
      loadConnectorRouting(auth.supabase),
    ]);
    return Response.json(homepageDailyBrief(cache, routing.activeConnectors, tenant.timezone), { headers });
  } catch (error) {
    logger.error("recommended_analysis.get_failed", safeErrorEvidence(error), correlationId);
    return Response.json({ error: "Recommended analysis could not be loaded." }, {
      status: error instanceof ControlPlaneError ? error.status : 503,
      headers,
    });
  }
}
