import { ControlPlaneError, loadConnectionsWorkspace } from "@/services/control-plane/src/web-repository";

export async function GET() {
  try {
    const workspace = await loadConnectionsWorkspace();
    return Response.json({ workspace }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "Connection status is unavailable.";
    return Response.json({ error: message }, { status });
  }
}
