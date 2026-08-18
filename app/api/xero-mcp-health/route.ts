import { xeroMcpServiceUrl } from "@/packages/xero-mcp/src/client";

export async function GET(): Promise<Response> {
  const base = xeroMcpServiceUrl();
  try {
    const response = await fetch(new URL("/livez", `${base}/`), {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    const payload = await response.json().catch(() => null);
    return Response.json({
      ok: response.ok,
      service: base.includes("127.0.0.1") || base.includes("localhost") ? "local" : "worker",
      live: Boolean(payload && typeof payload === "object" && "live" in payload && payload.live),
    });
  } catch (error) {
    return Response.json({
      ok: false,
      service: base.includes("127.0.0.1") || base.includes("localhost") ? "local" : "worker",
      error: error instanceof Error ? error.name : "fetch_failed",
    }, { status: 503 });
  }
}
