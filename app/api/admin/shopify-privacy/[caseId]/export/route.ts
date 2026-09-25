import { z } from "zod";
import { createShopifyPrivacyExport } from "@/services/control-plane/src/operator-repository";
import { assertSameOriginMutation } from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    assertSameOriginMutation(request);
    const caseId = ulidSchema.safeParse((await params).caseId);
    if (!caseId.success) {
      return Response.json({ error: "A valid privacy case is required." }, { status: 400 });
    }
    const result = await createShopifyPrivacyExport(caseId.data);
    return new Response(JSON.stringify(result.artifact), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="shopify-customer-data-${result.artifact.exportId}.json"`,
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Content-Type": "application/json; charset=utf-8",
        "Digest": `sha-256=${Buffer.from(result.artifactSha256, "hex").toString("base64")}`,
        "X-Albert-Artifact-SHA256": result.artifactSha256,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "The Shopify privacy export is unavailable.";
    return Response.json({ error: message }, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
