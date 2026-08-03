import { loadOperatorFleet } from "@/services/control-plane/src/operator-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

export async function GET() {
  try {
    return Response.json({ fleet: await loadOperatorFleet() }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "Fleet status is unavailable.";
    return Response.json({ error: message }, { status });
  }
}
