import { inspectRuntimeEnvironment, type RuntimeReadiness } from "./env.js";

// next.config.ts replaces this exact process.env reference at compile time.
// Do not derive the bundle identity from the generic runtime source below.
export const EMBEDDED_WEB_BUILD_SHA = (
  process.env.ALBERT_BUILD_SHA ?? ""
).trim().toLowerCase();

export type WebDependencyChecks = Readonly<{
  configuration: boolean;
  releaseIdentity: boolean;
  supabaseAuth: boolean;
  syncWorker: boolean;
  semanticQuery: boolean;
  anthropicAnalytics: boolean;
  operatorDiagnostic: boolean;
}>;

export type WebDependencyReadiness = Readonly<{
  ready: boolean;
  configuration: RuntimeReadiness;
  checks: WebDependencyChecks;
}>;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function endpoint(origin: string, pathname: string): string {
  return new URL(pathname, origin.endsWith("/") ? origin : `${origin}/`).toString();
}

async function successfulProbe(
  fetcher: Fetcher,
  url: string,
  headers?: Readonly<Record<string, string>>,
): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const MAX_READINESS_BODY_BYTES = 4_096;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_READINESS_BODY_BYTES) {
    await response.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_READINESS_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

async function exactServiceReadinessProbe(
  fetcher: Fetcher,
  url: string,
  expectedSha: string,
  expectedDeploymentId: string,
): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const payload = await boundedJson(response);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const readiness = payload as Record<string, unknown>;
    return readiness.releaseSha === expectedSha &&
      readiness.deploymentId === expectedDeploymentId &&
      (readiness.ready === true || readiness.status === "ready");
  } catch {
    return false;
  }
}

/** Probes only non-sensitive readiness endpoints and never returns configured URLs or keys. */
export async function inspectWebDependencies(
  source: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: Fetcher = fetch,
  embeddedBuildSha: string = EMBEDDED_WEB_BUILD_SHA,
): Promise<WebDependencyReadiness> {
  const configuration = inspectRuntimeEnvironment("web", source);
  const buildSha = embeddedBuildSha.trim().toLowerCase();
  const runtimeSha = source.ALBERT_SERVICE_VERSION?.trim().toLowerCase() ?? "";
  const deploymentId = source.ALBERT_DEPLOYMENT_ID?.trim() ?? "";
  const releaseIdentity = /^[a-f0-9]{40}$/u.test(buildSha) &&
    buildSha === runtimeSha &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(deploymentId);
  if (!configuration.ready || !releaseIdentity) {
    const checks = Object.freeze({
      configuration: configuration.ready,
      releaseIdentity,
      supabaseAuth: false,
      syncWorker: false,
      semanticQuery: false,
      anthropicAnalytics: false,
      operatorDiagnostic: false,
    });
    return Object.freeze({ ready: false, configuration, checks });
  }

  const supabaseUrl = source.NEXT_PUBLIC_SUPABASE_URL!;
  const publishableKey = source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const [supabaseAuth, syncWorker, semanticQuery, anthropicAnalytics, operatorDiagnostic] = await Promise.all([
    successfulProbe(fetcher, endpoint(supabaseUrl, "/auth/v1/health"), {
      apikey: publishableKey,
    }),
    exactServiceReadinessProbe(
      fetcher, endpoint(source.SYNC_WORKER_INTERNAL_URL!, "/readyz"), buildSha, deploymentId,
    ),
    exactServiceReadinessProbe(
      fetcher, endpoint(source.SEMANTIC_QUERY_SERVICE_URL!, "/readyz"), buildSha, deploymentId,
    ),
    exactServiceReadinessProbe(
      fetcher, endpoint(source.ANTHROPIC_ANALYTICS_SERVICE_URL!, "/readyz"), buildSha, deploymentId,
    ),
    exactServiceReadinessProbe(
      fetcher, endpoint(source.OPERATOR_DIAGNOSTIC_SERVICE_URL!, "/readyz"), buildSha, deploymentId,
    ),
  ]);
  const checks = Object.freeze({
    configuration: true,
    releaseIdentity: true,
    supabaseAuth,
    syncWorker,
    semanticQuery,
    anthropicAnalytics,
    operatorDiagnostic,
  });
  return Object.freeze({
    ready: Object.values(checks).every(Boolean),
    configuration,
    checks,
  });
}
