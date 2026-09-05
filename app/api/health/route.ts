import {
  EMBEDDED_WEB_BUILD_SHA,
  inspectWebDependencies,
} from "@/packages/config/src/health";
import { connection } from "next/server";
import { resolveWebReleaseIdentity } from "@/packages/config/src/vercel-runtime";

// Cache Components makes routes dynamic by default. Await connection() so this
// probe always reflects the live environment and is never prerendered.
export async function GET(): Promise<Response> {
  await connection();
  const readiness = await inspectWebDependencies(
    process.env,
    fetch,
    EMBEDDED_WEB_BUILD_SHA,
  );
  const releaseSha = /^[a-f0-9]{40}$/u.test(EMBEDDED_WEB_BUILD_SHA)
    ? EMBEDDED_WEB_BUILD_SHA
    : null;
  const releaseIdentity = resolveWebReleaseIdentity(process.env);
  return Response.json(
    {
      ready: readiness.ready,
      status: readiness.ready ? "ready" : "not_ready",
      runtime: "web",
      releaseSha,
      deploymentId: releaseIdentity.deploymentId || null,
      checks: readiness.checks,
    },
    { status: readiness.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
