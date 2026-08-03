import { z } from "zod";
import {
  bootstrapTenant,
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { isInternalOperator } from "@/services/control-plane/src/operator-repository";
import { assertSameOriginMutation } from "@/services/control-plane/src/request-security";

const bootstrapSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100).default("Australia/Melbourne"),
});

function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "The control plane is unavailable." }, { status: 503 });
}

export async function GET() {
  try {
    const { user } = await requireUser();
    const context = await currentTenantContext();
    const internalOperator = await isInternalOperator();
    return Response.json({
      user: {
        id: user.id,
        email: user.email ?? null,
        suggestedOrganisationName:
          typeof user.user_metadata.organisation_name === "string"
            ? user.user_metadata.organisation_name
            : null,
        timezone:
          typeof user.user_metadata.timezone === "string"
            ? user.user_metadata.timezone
            : "Australia/Melbourne",
      },
      context,
      internalOperator,
      needsBootstrap: context === null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const body = bootstrapSchema.safeParse(await request.json());
    if (!body.success) {
      return Response.json({ error: "A valid organisation name and timezone are required." }, { status: 400 });
    }
    const context = await bootstrapTenant(body.data);
    return Response.json({ context }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
