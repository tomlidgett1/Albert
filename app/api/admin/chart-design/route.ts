import { loadPublishedChartDesign, savePublishedChartDesign } from "@/services/control-plane/src/chart-design-repository";
import { isInternalOperator } from "@/services/control-plane/src/operator-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const CHART_DESIGN_BODY_LIMIT_BYTES = 65_536;

function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "The chart design could not be updated." }, { status: 503 });
}

export async function GET() {
  try {
    if (!(await isInternalOperator())) {
      return Response.json({ error: "Internal operator access is required." }, { status: 403 });
    }
    return Response.json({ design: await loadPublishedChartDesign() }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOriginMutation(request);
    if (!(await isInternalOperator())) {
      return Response.json({ error: "Internal operator access is required." }, { status: 403 });
    }
    const body = await readBoundedJsonBody(request, CHART_DESIGN_BODY_LIMIT_BYTES);
    const payload = body && typeof body === "object" && !Array.isArray(body)
      ? body as { design?: unknown }
      : {};
    const design = await savePublishedChartDesign(payload.design ?? body);
    return Response.json({ design }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
