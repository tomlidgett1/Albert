import {
  EMBEDDED_WEB_BUILD_SHA,
  inspectWebDependencies,
} from "@/packages/config/src/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const readiness = await inspectWebDependencies(
    process.env,
    fetch,
    EMBEDDED_WEB_BUILD_SHA,
  );
  const releaseSha = /^[a-f0-9]{40}$/u.test(EMBEDDED_WEB_BUILD_SHA)
    ? EMBEDDED_WEB_BUILD_SHA
    : null;
  return Response.json(
    {
      ready: readiness.ready,
      status: readiness.ready ? "ready" : "not_ready",
      runtime: "web",
      releaseSha,
      deploymentId: process.env.ALBERT_DEPLOYMENT_ID?.trim() || null,
      checks: readiness.checks,
    },
    { status: readiness.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
