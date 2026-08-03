import { inspectRuntimeEnvironment, type RuntimeReadiness } from "./env.js";

export type WebDependencyChecks = Readonly<{
  configuration: boolean;
  supabaseAuth: boolean;
  syncWorker: boolean;
  semanticQuery: boolean;
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

/** Probes only non-sensitive readiness endpoints and never returns configured URLs or keys. */
export async function inspectWebDependencies(
  source: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: Fetcher = fetch,
): Promise<WebDependencyReadiness> {
  const configuration = inspectRuntimeEnvironment("web", source);
  if (!configuration.ready) {
    const checks = Object.freeze({
      configuration: false,
      supabaseAuth: false,
      syncWorker: false,
      semanticQuery: false,
    });
    return Object.freeze({ ready: false, configuration, checks });
  }

  const supabaseUrl = source.NEXT_PUBLIC_SUPABASE_URL!;
  const publishableKey = source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const [supabaseAuth, syncWorker, semanticQuery] = await Promise.all([
    successfulProbe(fetcher, endpoint(supabaseUrl, "/auth/v1/health"), {
      apikey: publishableKey,
    }),
    successfulProbe(fetcher, endpoint(source.SYNC_WORKER_INTERNAL_URL!, "/readyz")),
    successfulProbe(fetcher, endpoint(source.SEMANTIC_QUERY_SERVICE_URL!, "/readyz")),
  ]);
  const checks = Object.freeze({
    configuration: true,
    supabaseAuth,
    syncWorker,
    semanticQuery,
  });
  return Object.freeze({
    ready: Object.values(checks).every(Boolean),
    configuration,
    checks,
  });
}
