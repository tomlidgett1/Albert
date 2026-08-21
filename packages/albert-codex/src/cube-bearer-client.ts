import {
  catalogueFromMeta,
  cubeQueryHash,
  enforceCubeResultPrivacy,
  validateCubeQuery,
  type ValidatedCubeQuery,
} from "../../albert-v3/src/cube/client.js";
import type {
  CubeCatalogue,
  CubeLoadResponse,
  CubeQuery,
} from "../../albert-v3/src/cube/types.js";

const CONTINUE_WAIT_TIMEOUT_MS = 90_000;
const CONTINUE_WAIT_POLL_MS = 1_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function assertCubeBearerScope(
  token: string,
  expected: Readonly<{
    tenantId: string;
    conversationId: string;
    turnId: string;
    role: string;
  }>,
): void {
  let payload: unknown;
  try {
    const encoded = token.split(".")[1];
    payload = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) : null;
  } catch {
    throw new Error("The Cube turn bearer is malformed.");
  }
  if (
    !isObject(payload)
    || payload.tenant_id !== expected.tenantId
    || payload.conversation_id !== expected.conversationId
    || payload.turn_id !== expected.turnId
    || payload.role !== expected.role
    || payload.specialist_agent_id !== "general"
    || payload.specialist_agent_version !== 1
    || typeof payload.exp !== "number"
    || payload.exp <= Math.floor(Date.now() / 1_000)
  ) {
    throw new Error("The Cube turn bearer is not scoped to this Codex turn.");
  }
}

/**
 * Cube client for the isolated Codex service. It accepts only a short-lived
 * bearer minted by the authenticated web route; the service cannot sign a
 * different tenant or turn and holds no Cube secret.
 */
export class CubeBearerClient {
  private readonly apiUrl: string;
  private readonly bearer: string;
  private readonly fetcher: typeof fetch;
  private cataloguePromise: Promise<CubeCatalogue> | undefined;
  private readonly resultCache = new Map<string, CubeLoadResponse>();

  constructor(options: Readonly<{
    apiUrl: string;
    bearer: string;
    fetcher?: typeof fetch;
  }>) {
    const url = new URL(options.apiUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
      throw new Error("The Codex semantic service requires HTTPS for Cube.");
    }
    this.apiUrl = url.toString().replace(/\/+$/u, "");
    this.bearer = options.bearer;
    this.fetcher = options.fetcher ?? fetch;
  }

  async fetchCatalogue(signal?: AbortSignal): Promise<CubeCatalogue> {
    this.cataloguePromise ??= (async () => {
      const response = await this.fetcher(`${this.apiUrl}/cubejs-api/v1/meta`, {
        headers: { Authorization: this.bearer },
        signal: signal ?? null,
      });
      if (!response.ok) {
        this.cataloguePromise = undefined;
        throw new Error(`Cube meta request failed with HTTP ${response.status}.`);
      }
      return catalogueFromMeta(await response.json());
    })();
    return this.cataloguePromise;
  }

  async loadQuery(
    query: CubeQuery,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<Readonly<{ validated: ValidatedCubeQuery | undefined; result: CubeLoadResponse }>> {
    const started = Date.now();
    const catalogue = await this.fetchCatalogue(options.signal);
    const validated = validateCubeQuery(query, catalogue);
    if ("error" in validated) {
      return {
        validated: undefined,
        result: { ok: false, error: validated.error, executionMs: Date.now() - started },
      };
    }
    const key = cubeQueryHash(validated.query);
    const cached = this.resultCache.get(key);
    if (cached?.ok) return { validated, result: { ...cached, cached: true } };
    const view = catalogue.views.find((candidate) => candidate.name === validated.view)!;
    const result = enforceCubeResultPrivacy(
      await this.executeLoad(validated.query, started, options.signal),
      view,
    );
    if (result.ok) this.resultCache.set(key, result);
    return { validated, result };
  }

  private async executeLoad(
    query: CubeQuery,
    started: number,
    signal?: AbortSignal,
  ): Promise<CubeLoadResponse> {
    const compare = (query.timeDimensions ?? []).some((dimension) => dimension.compareDateRange?.length);
    while (Date.now() - started < CONTINUE_WAIT_TIMEOUT_MS) {
      if (signal?.aborted) {
        return { ok: false, error: "The query was cancelled.", executionMs: Date.now() - started };
      }
      let status: number;
      let payload: unknown;
      try {
        const url = new URL(`${this.apiUrl}/cubejs-api/v1/load`);
        url.searchParams.set("query", JSON.stringify(query));
        if (compare) url.searchParams.set("queryType", "multi");
        const response = await this.fetcher(url, {
          headers: { Authorization: this.bearer },
          signal: signal ?? null,
        });
        status = response.status;
        payload = await response.json().catch(() => null);
      } catch (error) {
        return {
          ok: false,
          error: `Cube could not be reached (${error instanceof Error ? error.message : "network error"}).`,
          executionMs: Date.now() - started,
        };
      }
      const body = isObject(payload) ? payload : {};
      if (body.error === "Continue wait") {
        await new Promise((resolveWait) => setTimeout(resolveWait, CONTINUE_WAIT_POLL_MS));
        continue;
      }
      if (status !== 200 || typeof body.error === "string") {
        return {
          ok: false,
          error: typeof body.error === "string" ? body.error : `Cube returned HTTP ${status}.`,
          executionMs: Date.now() - started,
        };
      }
      const rows: Record<string, unknown>[] = [];
      const annotation: Record<string, { title: string; shortTitle: string; type: string; format?: string }> = {};
      if (Array.isArray(body.results)) {
        for (const entry of body.results) {
          if (!isObject(entry)) continue;
          const label = compareRangeLabel(entry.query);
          for (const row of Array.isArray(entry.data) ? entry.data.filter(isObject) : []) {
            rows.push(label && row.compareDateRange === undefined ? { ...row, compareDateRange: label } : row);
          }
          mergeAnnotation(annotation, entry.annotation);
        }
        if (rows.some((row) => row.compareDateRange !== undefined)) {
          annotation.compareDateRange ??= {
            title: "Compared date range", shortTitle: "Date range", type: "string",
          };
        }
      } else {
        rows.push(...(Array.isArray(body.data) ? body.data.filter(isObject) : []));
        mergeAnnotation(annotation, body.annotation);
      }
      return {
        ok: true,
        rows,
        annotation,
        executionMs: Date.now() - started,
        cached: false,
      };
    }
    return {
      ok: false,
      error: "Cube did not finish the query within 90 seconds.",
      executionMs: Date.now() - started,
    };
  }
}

function compareRangeLabel(resultQuery: unknown): string | undefined {
  if (!isObject(resultQuery) || !Array.isArray(resultQuery.timeDimensions)) return undefined;
  for (const raw of resultQuery.timeDimensions) {
    if (!isObject(raw)) continue;
    const range = raw.compareDateRange ?? raw.dateRange;
    if (Array.isArray(range) && range.length === 2) {
      const [from, to] = range;
      if (typeof from === "string" && typeof to === "string") return `${from.slice(0, 10)} to ${to.slice(0, 10)}`;
    }
    if (typeof range === "string") return range;
  }
  return undefined;
}

function mergeAnnotation(
  target: Record<string, { title: string; shortTitle: string; type: string; format?: string }>,
  raw: unknown,
): void {
  const source = isObject(raw) ? raw : {};
  for (const group of ["measures", "dimensions", "timeDimensions", "segments"]) {
    const section = isObject(source[group]) ? source[group] : {};
    for (const [member, info] of Object.entries(section)) {
      if (!isObject(info) || target[member]) continue;
      target[member] = {
        title: asString(info.title) ?? member,
        shortTitle: asString(info.shortTitle) ?? member.split(".")[1] ?? member,
        type: asString(info.type) ?? "string",
        ...(asString(info.format) ? { format: asString(info.format) } : {}),
      };
    }
  }
}
