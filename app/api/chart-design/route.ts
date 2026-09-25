import { loadPublishedChartDesign } from "@/services/control-plane/src/chart-design-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

export async function GET() {
  try {
    return Response.json({ design: await loadPublishedChartDesign() }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The chart design could not be loaded.";
    return Response.json({ error: message }, { status });
  }
}
