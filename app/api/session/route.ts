import { z } from "zod";
import {
  bootstrapTenant,
  ControlPlaneError,
  currentTenantSessionState,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { isInternalOperator } from "@/services/control-plane/src/operator-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";

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
    const [sessionState, internalOperator] = await Promise.all([
      currentTenantSessionState(),
      isInternalOperator(),
    ]);
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
      context: sessionState.context,
      internalOperator,
      deletionReceipt: sessionState.deletionReceipt,
      needsBootstrap: sessionState.needsBootstrap,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const body = bootstrapSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) {
      return Response.json({ error: "A valid organisation name and timezone are required." }, { status: 400 });
    }
    const context = await bootstrapTenant(body.data);
    return Response.json({ context }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
