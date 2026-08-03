import { z } from "zod";
import {
  addOrganisationMember,
  updateOrganisationMember,
} from "@/services/control-plane/src/organisation-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const roleSchema = z.enum(["owner", "manager", "bookkeeper"]);
const tenantIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const addSchema = z.object({
  tenantId: tenantIdSchema,
  email: z.string().trim().email().max(320),
  role: roleSchema,
}).strict();
const updateSchema = z.object({
  tenantId: tenantIdSchema,
  userId: z.string().uuid(),
  role: roleSchema,
  status: z.enum(["active", "revoked"]),
}).strict();

function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneError) return Response.json({ error: error.message }, { status: error.status });
  return Response.json({ error: "The organisation member could not be changed." }, { status: 503 });
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const body = addSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A confirmed Albert account and role are required." }, { status: 400 });
    await addOrganisationMember(body.data.tenantId, body.data.email, body.data.role);
    return Response.json({ added: true }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOriginMutation(request);
    const body = updateSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A valid member update is required." }, { status: 400 });
    await updateOrganisationMember({
      expectedTenantId: body.data.tenantId,
      userId: body.data.userId,
      role: body.data.role,
      status: body.data.status,
    });
    return Response.json({ updated: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
