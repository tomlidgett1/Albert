import { loadOperatorPipeline } from "@/services/control-plane/src/operator-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const { tenantId } = await params;
  if (!ulidPattern.test(tenantId)) return Response.json({ error: "A valid tenant is required." }, { status: 400 });
  try {
    return Response.json({ pipeline: await loadOperatorPipeline(tenantId) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The tenant pipeline is unavailable.";
    return Response.json({ error: message }, { status });
  }
}
