import { z } from "zod";
import {
  createOrganisation,
  listOrganisations,
  loadOrganisationSettings,
  renameOrganisation,
} from "@/services/control-plane/src/organisation-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(100),
}).strict();
const tenantIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const renameSchema = z.object({
  tenantId: tenantIdSchema,
  displayName: z.string().trim().min(1).max(120),
}).strict();

function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneError) return Response.json({ error: error.message }, { status: error.status });
  return Response.json({ error: "Organisation settings are unavailable." }, { status: 503 });
}

export async function GET() {
  try {
    const [organisations, settings] = await Promise.all([
      listOrganisations(),
      loadOrganisationSettings(),
    ]);
    return Response.json({ organisations, settings }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const body = createSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A valid name and timezone are required." }, { status: 400 });
    const context = await createOrganisation(body.data);
    return Response.json({ context }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOriginMutation(request);
    const body = renameSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A valid organisation name is required." }, { status: 400 });
    await renameOrganisation(body.data.tenantId, body.data.displayName);
    return Response.json({ updated: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
