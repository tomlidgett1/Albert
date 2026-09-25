import {
  fivetranMyDataRowsInputSchema,
  loadFivetranMyDataRows,
} from "@/services/control-plane/src/my-data-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
});

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const input = fivetranMyDataRowsInputSchema.safeParse(
      await readBoundedJsonBody(request, 2_048),
    );
    if (!input.success) {
      return Response.json({ error: "A valid Fivetran table page is required." }, {
        status: 400,
        headers: responseHeaders,
      });
    }
    return Response.json({ table: await loadFivetranMyDataRows(input.data) }, {
      headers: responseHeaders,
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Fivetran table data is unavailable.";
    return Response.json({ error: message }, { status, headers: responseHeaders });
  }
}
