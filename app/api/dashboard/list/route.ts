/** Every dashboard the member owns, most recently touched first (ADR 0134). */
import {
  ControlPlaneError,
  currentTenantContext,
} from "@/services/control-plane/src/web-repository";
import { listDashboards } from "@/services/control-plane/src/dashboard-repository";

export async function GET() {
  try {
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    return Response.json({ dashboards: await listDashboards() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The dashboards are unavailable.";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
