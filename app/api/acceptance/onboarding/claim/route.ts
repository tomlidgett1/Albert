import { z } from "zod";
import { claimProtectedDogfoodOnboardingJourney } from "@/services/control-plane/src/protected-dogfood-onboarding-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const inputSchema = z.object({
  journeyId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  browserNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const input = inputSchema.safeParse(await readBoundedJsonBody(request, 512));
    if (!input.success) {
      return Response.json({ error: "A valid one-use acceptance code is required." }, {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const claim = await claimProtectedDogfoodOnboardingJourney({
      ...input.data,
      userAgent: request.headers.get("user-agent") ?? "",
    });
    return Response.json({ claim }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "The protected onboarding journey could not be claimed.";
    return Response.json({ error: message }, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
