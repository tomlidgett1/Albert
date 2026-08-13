import {
  ControlPlaneError,
  currentTenantContext,
} from "@/services/control-plane/src/web-repository";
import { loadDashboard } from "@/services/control-plane/src/dashboard-repository";

export async function GET() {
  try {
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    return Response.json({ dashboard: await loadDashboard() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The dashboard is unavailable.";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

