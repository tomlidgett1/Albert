import { loadShopifyPrivacyCases } from "@/services/control-plane/src/operator-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

export async function GET() {
  try {
    const cases = await loadShopifyPrivacyCases();
    return Response.json({ cases }, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Shopify privacy cases are unavailable.";
    return Response.json({ error: message }, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
