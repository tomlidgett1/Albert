import { ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { isInternalOperator } from "@/services/control-plane/src/operator-repository";

export async function GET() {
  try {
    return Response.json({ internalOperator: await isInternalOperator() }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({ error: "Operator access could not be verified." }, { status });
  }
}
