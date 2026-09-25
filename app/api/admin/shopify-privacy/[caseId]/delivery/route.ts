import { z } from "zod";
import { recordShopifyPrivacyDelivery } from "@/services/control-plane/src/operator-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const inputSchema = z.object({
  exportId: ulidSchema,
  deliveryChannel: z.enum(["direct_to_shop_owner", "approved_secure_portal"]),
  deliveredAt: z.string().datetime({ offset: true }),
}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    assertSameOriginMutation(request);
    const caseId = ulidSchema.safeParse((await params).caseId);
    const input = inputSchema.safeParse(await readBoundedJsonBody(request, 1_024));
    if (!caseId.success || !input.success) {
      return Response.json({ error: "Valid delivery evidence is required." }, { status: 400 });
    }
    await recordShopifyPrivacyDelivery({ caseId: caseId.data, ...input.data });
    return Response.json({ caseId: caseId.data, status: "completed" }, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Shopify privacy delivery evidence is unavailable.";
    return Response.json({ error: message }, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
