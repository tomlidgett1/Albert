import { signInternalRequest } from "../../../packages/security/src/index.js";

export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OAuthFlowError(`OAuth is not configured (${name}).`, 503);
  return value;
}

const DEFAULT_WORKER_TIMEOUT_MS = 45_000;
/** Fivetran Stripe create runs setup tests, enables the ERD, then starts ALL_TIME sync. */
const FIVETRAN_START_TIMEOUT_MS = 180_000;

export async function callWorker<T>(
  path: string,
  bodyValue: unknown,
  options?: Readonly<{ timeoutMs?: number }>,
): Promise<T> {
  const baseUrl = requiredEnvironment("SYNC_WORKER_INTERNAL_URL");
  const secret = requiredEnvironment("ALBERT_OAUTH_WORKER_SIGNING_SECRET");
  const body = JSON.stringify(bodyValue);
  const headers = await signInternalRequest({ method: "POST", path, body, secret });
  const timeoutMs = options?.timeoutMs
    ?? (/^\/v1\/fivetran\/[a-z0-9_]+\/start$/u.test(path) ? FIVETRAN_START_TIMEOUT_MS : DEFAULT_WORKER_TIMEOUT_MS);
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null) as {
    result?: T;
    error?: string;
    detail?: string;
  } | null;
  if (!response.ok) {
    throw new OAuthFlowError(
      payload?.error || "The OAuth worker rejected the request.",
      response.status,
      typeof payload?.detail === "string" ? payload.detail : undefined,
    );
  }
  if (!payload || !("result" in payload)) {
    throw new OAuthFlowError("The OAuth worker returned an invalid response.", 502);
  }
  return payload.result as T;
}

export async function disconnectFivetranXero(input: Readonly<{
  tenantId: string;
  userId: string;
  connectionId: string;
}>): Promise<{ connectionId: string; status: string; nativeConnectionId?: string }> {
  return callWorker("/v1/fivetran/connection/disconnect", input);
}

export async function syncFivetranXero(input: Readonly<{
  tenantId: string;
  userId: string;
  connectionId: string;
}>): Promise<{ accepted: true; syncRunId: string }> {
  return callWorker("/v1/fivetran/connection/sync", input);
}

export type FivetranXeroSyncStatus = Readonly<{
  connectionId: string;
  phase: "historical" | "incremental" | "up_to_date" | "scheduled" | "paused" | "failed" | "broken";
  progress?: number;
  paused: boolean;
  setupState: string;
  syncState: string;
  succeededAt: string | null;
  failedAt: string | null;
  warnings: readonly string[];
  schemaLoaded: boolean;
  enabledTables: number;
  landedTables: number;
  totalRows: number;
  tables: ReadonlyArray<Readonly<{ table: string; rows: number }>>;
  checkedAt: string;
}>;

export async function fivetranXeroSyncStatus(input: Readonly<{
  tenantId: string;
  userId: string;
  connectionId: string;
}>): Promise<FivetranXeroSyncStatus> {
  return callWorker("/v1/fivetran/connection/status", input);
}
