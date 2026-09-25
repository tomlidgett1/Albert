import { loadFivetranMyDataCatalogue } from "@/services/control-plane/src/my-data-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
});

export async function GET() {
  try {
    return Response.json({ catalogue: await loadFivetranMyDataCatalogue() }, {
      headers: responseHeaders,
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Fivetran data is unavailable.";
    return Response.json({ error: message }, { status, headers: responseHeaders });
  }
}
