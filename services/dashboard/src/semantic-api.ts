/**
 * Partner semantic API (ADR 0153): governed Cube JSON queries for a partner
 * product's own charts, without an Omni turn.
 *
 * Every query passes the same gate as a dashboard refresh: a strict schema,
 * validateCubeQuery against the live catalogue (one view, known members, the
 * view's privacy policy) and enforceCubeResultPrivacy on the rows. Queries
 * run under the member's semantic query lease; a batch shares one lease, and
 * so one Cube orchestrator, and runs a few at a time.
 */
import { z } from "zod";
import { CubeClient, validateCubeQuery } from "@/packages/albert-v3/src/cube/client";
import { signCubeJwt } from "@/packages/albert-v3/src/cube/jwt";
import {
  CUBE_GRANULARITIES,
  type CubeCatalogue,
  type CubeFilter,
  type CubeQuery,
} from "@/packages/albert-v3/src/cube/types";
import { sanitizeQueryFailureMessage } from "@/packages/shared/src/query-audit";
import { cachedCatalogue } from "./catalogue-cache";

export const SEMANTIC_BATCH_MAX = 12;
const BATCH_CONCURRENCY = 4;
const QUERY_TIMEOUT_MS = 100_000;
const META_TIMEOUT_MS = 20_000;

const MEMBER = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u).max(160);
const OPERATORS = [
  "equals", "notEquals", "contains", "notContains", "startsWith", "notStartsWith", "endsWith",
  "notEndsWith", "gt", "gte", "lt", "lte", "set", "notSet", "inDateRange", "notInDateRange",
  "beforeDate", "afterDate",
] as const;

const memberFilterSchema = z.object({
  member: MEMBER,
  operator: z.enum(OPERATORS),
  values: z.array(z.string().max(500)).max(200).optional(),
}).strict();

const filterSchema: z.ZodType<CubeFilter> = z.lazy(() => z.union([
  memberFilterSchema,
  z.object({ and: z.array(filterSchema).min(1).max(20) }).strict(),
  z.object({ or: z.array(filterSchema).min(1).max(20) }).strict(),
]));

const DATE = z.string().max(40);

export const semanticQuerySchema = z.object({
  // A partner's table lists many columns at once (Omni's own queries stay far smaller).
  measures: z.array(MEMBER).max(40).optional(),
  dimensions: z.array(MEMBER).max(50).optional(),
  segments: z.array(MEMBER).max(8).optional(),
  timeDimensions: z.array(z.object({
    dimension: MEMBER,
    granularity: z.enum(CUBE_GRANULARITIES).optional(),
    dateRange: z.union([z.string().max(80), z.tuple([DATE, DATE])]).optional(),
  }).strict()).max(2).optional(),
  filters: z.array(filterSchema).max(30).optional(),
  order: z.record(MEMBER, z.enum(["asc", "desc"])).optional(),
  limit: z.number().int().min(1).max(2_000).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
  /** Row listing: dimensions per row, no grouping (views without an aggregate-only policy). */
  ungrouped: z.boolean().optional(),
  /** Also count every matching row (for "N rows" under a table). */
  total: z.boolean().optional(),
  timezone: z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/u).max(64).optional(),
}).strict();

export type SemanticQuery = z.infer<typeof semanticQuerySchema>;

export const semanticBatchSchema = z.object({
  expectedTenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  queries: z.array(semanticQuerySchema).min(1).max(SEMANTIC_BATCH_MAX),
}).strict();

export type SemanticQueryResult =
  | Readonly<{
    ok: true;
    view: string;
    rows: readonly Readonly<Record<string, unknown>>[];
    annotation: Readonly<Record<string, unknown>>;
    total?: number;
    executionMs: number;
  }>
  | Readonly<{ ok: false; code: "query_invalid" | "query_timeout" | "cube_query_failed"; error: string }>;

export type CubeRuntime = Readonly<{ apiUrl: string; apiSecret: string }>;

export function cubeRuntime(): CubeRuntime | null {
  const apiUrl = process.env.CUBE_API_URL?.trim();
  const apiSecret = process.env.CUBEJS_API_SECRET?.trim();
  return apiUrl && apiSecret ? { apiUrl, apiSecret } : null;
}

// ------------------------------------------------------------
// Catalogue
// ------------------------------------------------------------

export type PartnerMember = Readonly<{
  name: string;
  kind: "measure" | "dimension" | "segment";
  title: string;
  shortTitle: string;
  description?: string;
  type?: string;
  format?: string;
  aggType?: string;
  aiContext?: string;
  folder?: string;
}>;

export type PartnerView = Readonly<{
  name: string;
  title: string;
  description?: string;
  aiContext?: string;
  queryPolicy?: "aggregate_only";
  minimumTimeGranularity?: string;
  members: readonly PartnerMember[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Display formats and measure aggregations, which the governed catalogue does not carry. */
async function rawMemberDetails(runtime: CubeRuntime, tenantId: string): Promise<Map<string, { format?: string; aggType?: string }>> {
  const token = signCubeJwt({ secret: runtime.apiSecret, securityContext: { tenant_id: tenantId }, expiresInSeconds: 120 });
  const response = await fetch(`${runtime.apiUrl.replace(/\/+$/u, "")}/cubejs-api/v1/meta`, {
    headers: { Authorization: token },
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Cube meta request failed with HTTP ${response.status}.`);
  const meta = await response.json() as unknown;
  const details = new Map<string, { format?: string; aggType?: string }>();
  if (!isRecord(meta) || !Array.isArray(meta.cubes)) return details;
  for (const cube of meta.cubes) {
    if (!isRecord(cube)) continue;
    for (const key of ["measures", "dimensions"] as const) {
      for (const member of Array.isArray(cube[key]) ? cube[key] as unknown[] : []) {
        if (!isRecord(member) || typeof member.name !== "string") continue;
        details.set(member.name, {
          ...(typeof member.format === "string" ? { format: member.format } : {}),
          ...(key === "measures" && typeof member.aggType === "string" ? { aggType: member.aggType } : {}),
        });
      }
    }
  }
  return details;
}

let detailsCache: { fetchedAt: number; promise: Promise<Map<string, { format?: string; aggType?: string }>> } | null = null;

/**
 * The views a partner may query: the governed catalogue minus members hidden
 * from every model-facing surface and each view's tenant key.
 */
export async function partnerCatalogue(runtime: CubeRuntime, tenantId: string): Promise<{ catalogue: CubeCatalogue; views: PartnerView[] }> {
  const client = new CubeClient({ apiUrl: runtime.apiUrl, apiSecret: runtime.apiSecret, securityContext: { tenant_id: tenantId } });
  const catalogue = await cachedCatalogue(runtime.apiUrl, client);
  if (!detailsCache || Date.now() - detailsCache.fetchedAt > 5 * 60_000) {
    const promise = rawMemberDetails(runtime, tenantId);
    detailsCache = { fetchedAt: Date.now(), promise };
    promise.catch(() => {
      if (detailsCache?.promise === promise) detailsCache = null;
    });
  }
  const details = await detailsCache.promise.catch(() => new Map<string, { format?: string; aggType?: string }>());
  const views = catalogue.views.map((view): PartnerView => ({
    name: view.name,
    title: view.title,
    ...(view.description ? { description: view.description } : {}),
    ...(view.aiContext ? { aiContext: view.aiContext } : {}),
    ...(view.queryPolicy ? { queryPolicy: view.queryPolicy } : {}),
    ...(view.minimumTimeGranularity ? { minimumTimeGranularity: view.minimumTimeGranularity } : {}),
    members: view.members
      .filter((member) => !member.aiHidden && !member.name.endsWith(".tenant_id"))
      .map((member): PartnerMember => ({
        name: member.name,
        kind: member.kind,
        title: member.title,
        shortTitle: member.shortTitle,
        ...(member.description ? { description: member.description } : {}),
        ...(member.type ? { type: member.type } : {}),
        ...(member.aiContext ? { aiContext: member.aiContext } : {}),
        ...(member.folder ? { folder: member.folder } : {}),
        ...details.get(member.name),
      })),
  }));
  return { catalogue, views };
}

// ------------------------------------------------------------
// Queries
// ------------------------------------------------------------

/** Checks a batch before any lease is claimed; the error sits at the query's position. */
export function validateBatch(
  queries: readonly SemanticQuery[],
  catalogue: CubeCatalogue,
): Array<{ query: CubeQuery; view: string } | { error: string }> {
  return queries.map((query) => {
    const validated = validateCubeQuery(query as CubeQuery, catalogue);
    if ("error" in validated) return { error: validated.error };
    const view = catalogue.views.find((candidate) => candidate.name === validated.view);
    if (query.ungrouped && view?.queryPolicy === "aggregate_only") {
      return { error: `${view.title} only answers aggregated questions; row listings are not available.` };
    }
    return { query: validated.query, view: validated.view };
  });
}

/** Runs validated queries under one semantic query lease, a few at a time. */
export async function runBatch(
  runtime: CubeRuntime,
  context: Readonly<{ tenantId: string; role: "owner" | "manager"; leaseId: string }>,
  checked: ReadonlyArray<{ query: CubeQuery; view: string } | { error: string }>,
): Promise<SemanticQueryResult[]> {
  const client = new CubeClient({
    apiUrl: runtime.apiUrl,
    apiSecret: runtime.apiSecret,
    securityContext: {
      tenant_id: context.tenantId,
      role: context.role,
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      semantic_query_lease_id: context.leaseId,
    },
  });
  const results: SemanticQueryResult[] = new Array(checked.length);
  let next = 0;
  const worker = async () => {
    while (next < checked.length) {
      const index = next++;
      const entry = checked[index]!;
      if ("error" in entry) {
        results[index] = { ok: false, code: "query_invalid", error: entry.error };
        continue;
      }
      try {
        const { result } = await client.loadQuery(entry.query, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
        if (result.ok) {
          results[index] = {
            ok: true,
            view: entry.view,
            rows: result.rows,
            annotation: result.annotation,
            ...(result.total !== undefined ? { total: result.total } : {}),
            executionMs: result.executionMs,
          };
        } else {
          const timeout = /within 90 seconds|timed out|timeout|cancelled|aborted/iu.test(result.error);
          results[index] = {
            ok: false,
            code: timeout ? "query_timeout" : "cube_query_failed",
            error: timeout
              ? "The query took too long. Try a shorter date range or fewer breakdowns."
              : sanitizeQueryFailureMessage(result.error, "Cube could not run this query."),
          };
        }
      } catch (error) {
        results[index] = {
          ok: false,
          code: "cube_query_failed",
          error: sanitizeQueryFailureMessage(error, "Cube could not run this query."),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, checked.length) }, worker));
  return results;
}
