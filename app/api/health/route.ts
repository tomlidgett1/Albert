import { inspectWebDependencies } from "@/packages/config/src/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const readiness = await inspectWebDependencies();
  return Response.json(
    {
      status: readiness.ready ? "ready" : "not_ready",
      runtime: "web",
      checks: readiness.checks,
    },
    { status: readiness.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
