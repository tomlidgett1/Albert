import { z } from "zod";
import { selectOrganisation } from "@/services/control-plane/src/organisation-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const schema = z.object({ tenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }).strict();

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const body = schema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A valid organisation is required." }, { status: 400 });
    await selectOrganisation(body.data.tenantId);
    return Response.json({ selected: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ControlPlaneError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "The organisation could not be selected." }, { status: 503 });
  }
}
