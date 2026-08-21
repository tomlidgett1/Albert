import { createHash } from "node:crypto";
import { dump as dumpYaml } from "js-yaml";
import { signCubeJwt } from "./jwt.js";
import {
  CUBE_GRANULARITIES,
  type CubeCatalogue,
  type CubeCatalogueMember,
  type CubeCatalogueView,
  type CubeLoadResponse,
  type CubeQuery,
  type CubeSecurityContext,
} from "./types.js";

const DEFAULT_ROW_LIMIT = 500;
const MAX_ROW_LIMIT = 2_000;
const CONTINUE_WAIT_TIMEOUT_MS = 90_000;
const CONTINUE_WAIT_POLL_MS = 1_000;

export type CubeClientOptions = Readonly<{
  apiUrl: string;
  apiSecret: string;
  securityContext: CubeSecurityContext;
  fetcher?: typeof fetch;
}>;

export type ValidatedCubeQuery = Readonly<{
  query: CubeQuery;
  /** The single view every member of the query belongs to. */
  view: string;
  /** Underlying cubes resolved through the view's alias members. */
  cubes: readonly string[];
  members: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function explicitDateRange(value: string | readonly [string, string]): readonly [string, string] | null {
  const pair = typeof value === "string" ? value.split(",") : [...value];
  if (pair.length !== 2) return null;
  const start = pair[0]?.trim() ?? "";
  const end = pair[1]?.trim() ?? "";
  if (!isRealIsoDate(start) || !isRealIsoDate(end) || start > end) return null;
  return [start, end];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(asString(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function memberFolder(
  folders: readonly Readonly<{ name: string; members: readonly string[] }>[],
  memberName: string,
): string | undefined {
  const short = memberName.split(".")[1] ?? memberName;
  for (const folder of folders) {
    if (folder.members.includes(short) || folder.members.includes(memberName)) {
      return folder.name;
    }
  }
  return undefined;
}

function parseMembers(
  cube: Record<string, unknown>,
  kind: "measure" | "dimension" | "segment",
): readonly CubeCatalogueMember[] {
  const key = kind === "measure" ? "measures" : kind === "dimension" ? "dimensions" : "segments";
  const raw = Array.isArray(cube[key]) ? cube[key] as unknown[] : [];
  const folders = Array.isArray(cube.folders)
    ? (cube.folders as unknown[]).flatMap((folder) => {
        if (!isRecord(folder)) return [];
        const name = asString(folder.name);
        const members = Array.isArray(folder.members)
          ? (folder.members as unknown[]).filter((member): member is string => typeof member === "string")
          : [];
        return name ? [{ name, members }] : [];
      })
    : [];
  return raw.flatMap((entry): CubeCatalogueMember[] => {
    if (!isRecord(entry)) return [];
    const name = asString(entry.name);
    if (!name) return [];
    if (entry.public === false || entry.isVisible === false) return [];
    const meta = isRecord(entry.meta) ? entry.meta : {};
    const type = asString(entry.type);
    return [{
      name,
      kind,
      title: asString(entry.title) ?? name,
      shortTitle: asString(entry.shortTitle) ?? name.split(".")[1] ?? name,
      ...(asString(entry.description) ? { description: asString(entry.description) } : {}),
      ...(type === "string" || type === "number" || type === "boolean" || type === "time"
        ? { type }
        : {}),
      ...(asString(meta.ai_context) ? { aiContext: asString(meta.ai_context) } : {}),
      ...(meta.ai_hidden === true || meta.aiHidden === true ? { aiHidden: true } : {}),
      ...(memberFolder(folders, name) ? { folder: memberFolder(folders, name) } : {}),
      ...(asString(entry.aliasMember) ? { aliasMember: asString(entry.aliasMember) } : {}),
    }];
  });
}

export function catalogueFromMeta(meta: unknown): CubeCatalogue {
  if (!isRecord(meta) || !Array.isArray(meta.cubes)) {
    throw new Error("Cube meta returned an unexpected shape.");
  }
  const views: CubeCatalogueView[] = [];
  for (const cube of meta.cubes as unknown[]) {
    if (!isRecord(cube)) continue;
    const name = asString(cube.name);
    if (!name) continue;
    if (cube.public === false || cube.isVisible === false) continue;
    const cubeMeta = isRecord(cube.meta) ? cube.meta : {};
    const privacyPolicy = asString(cubeMeta.privacy_policy);
    const minimumTimeGranularity = asString(cubeMeta.minimum_time_granularity);
    const minimumGroupSize = asPositiveInteger(cubeMeta.privacy_minimum_group_size);
    const populationMeasure = asString(cubeMeta.privacy_population_measure);
    views.push({
      name,
      title: asString(cube.title) ?? name,
      ...(asString(cube.description) ? { description: asString(cube.description) } : {}),
      ...(asString(cubeMeta.ai_context) ? { aiContext: asString(cubeMeta.ai_context) } : {}),
      ...(privacyPolicy === "aggregate_only" ? { queryPolicy: "aggregate_only" as const } : {}),
      ...(minimumTimeGranularity
          && CUBE_GRANULARITIES.includes(minimumTimeGranularity as (typeof CUBE_GRANULARITIES)[number])
        ? { minimumTimeGranularity: minimumTimeGranularity as (typeof CUBE_GRANULARITIES)[number] }
        : {}),
      ...(minimumGroupSize ? { minimumGroupSize } : {}),
      ...(populationMeasure
        ? { populationMeasure: populationMeasure.includes(".") ? populationMeasure : `${name}.${populationMeasure}` }
        : {}),
      members: [
        ...parseMembers(cube, "measure"),
        ...parseMembers(cube, "dimension"),
        ...parseMembers(cube, "segment"),
      ],
    });
  }
  return { views, fetchedAt: new Date().toISOString() };
}

/** Renders a Cube JSON query as governed, user-safe YAML for the trace. */
export function cubeQueryToYaml(query: CubeQuery): string {
  const ordered: Record<string, unknown> = {};
  if (query.measures?.length) ordered.measures = [...query.measures];
  if (query.dimensions?.length) ordered.dimensions = [...query.dimensions];
  if (query.timeDimensions?.length) {
    ordered.timeDimensions = query.timeDimensions.map((td) => ({
      dimension: td.dimension,
      ...(td.granularity ? { granularity: td.granularity } : {}),
      ...(td.dateRange ? { dateRange: Array.isArray(td.dateRange) ? [...td.dateRange] : td.dateRange } : {}),
      ...(td.compareDateRange ? { compareDateRange: [...td.compareDateRange] } : {}),
    }));
  }
  if (query.segments?.length) ordered.segments = [...query.segments];
  if (query.filters?.length) ordered.filters = JSON.parse(JSON.stringify(query.filters));
  if (query.order && Object.keys(query.order).length > 0) ordered.order = { ...query.order };
  if (query.limit !== undefined) ordered.limit = query.limit;
  if (query.offset !== undefined) ordered.offset = query.offset;
  if (query.timezone) ordered.timezone = query.timezone;
  return dumpYaml(ordered, { lineWidth: 100, noRefs: true }).trimEnd();
}

export function cubeQueryHash(query: CubeQuery): string {
  return createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 24);
}

/** Full digest persisted in dashboard replay references and refresh evidence. */
export function cubeQueryDigest(query: CubeQuery): string {
  // Hash the stable replay representation. JSON property order is observable,
  // and the YAML serializer deliberately orders segments after time dimensions;
  // hashing raw JSON made an untouched replay look different after YAML parsing.
  return createHash("sha256").update(cubeQueryToYaml(query)).digest("hex");
}

function legacyEngineQueryDigest(query: CubeQuery): string {
  // Dashboard recipes created before the stable digest used JSON.stringify on
  // the engine's insertion order. Reconstruct that exact order so those pins
  // remain replayable without relaxing the integrity check.
  const ordered: Record<string, unknown> = {};
  if (query.measures?.length) ordered.measures = query.measures;
  if (query.dimensions?.length) ordered.dimensions = query.dimensions;
  if (query.segments?.length) ordered.segments = query.segments;
  if (query.timeDimensions?.length) ordered.timeDimensions = query.timeDimensions;
  if (query.filters?.length) ordered.filters = query.filters;
  if (query.order && Object.keys(query.order).length > 0) ordered.order = query.order;
  if (query.limit !== undefined) ordered.limit = query.limit;
  if (query.offset !== undefined) ordered.offset = query.offset;
  if (query.timezone) ordered.timezone = query.timezone;
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function cubeQueryReplayDigestMatches(query: CubeQuery, expectedDigest: string): boolean {
  return cubeQueryDigest(query) === expectedDigest || legacyEngineQueryDigest(query) === expectedDigest;
}

/**
 * Pins the exact governed view/member catalogue used to validate a query.
 * A refresh recomputes this digest and refuses to run if the semantic surface
 * has changed, preventing a pinned table from silently changing meaning.
 */
export function cubeSemanticVersionDigest(
  validated: ValidatedCubeQuery,
  catalogue: CubeCatalogue,
): string {
  const view = catalogue.views.find((candidate) => candidate.name === validated.view);
  const selectedMembers = (view?.members ?? [])
    .filter((member) => validated.members.includes(member.name))
    .map((member) => ({
      name: member.name,
      kind: member.kind,
      type: member.type ?? null,
      aliasMember: member.aliasMember ?? null,
      title: member.title,
      description: member.description ?? null,
      aiHidden: member.aiHidden ?? false,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(JSON.stringify({
    view: validated.view,
    queryPolicy: view?.queryPolicy ?? null,
    minimumTimeGranularity: view?.minimumTimeGranularity ?? null,
    minimumGroupSize: view?.minimumGroupSize ?? null,
    populationMeasure: view?.populationMeasure ?? null,
    cubes: [...validated.cubes].sort(),
    members: selectedMembers,
  })).digest("hex");
}

function collectFilterMembers(filters: CubeQuery["filters"], into: string[]): void {
  for (const filter of filters ?? []) {
    if ("and" in filter) collectFilterMembers(filter.and, into);
    else if ("or" in filter) collectFilterMembers(filter.or, into);
    else into.push(filter.member);
  }
}

/**
 * Validates a Cube JSON query against the live catalogue before execution:
 * every member must exist on exactly one curated view, time dimensions must be
 * time-typed, and limits are bounded. Returns the resolved view and the
 * underlying cubes for trace transparency.
 */
export function validateCubeQuery(
  query: CubeQuery,
  catalogue: CubeCatalogue,
): ValidatedCubeQuery | Readonly<{ error: string }> {
  const membersByName = new Map<string, { view: string; member: CubeCatalogueMember }>();
  for (const view of catalogue.views) {
    for (const member of view.members) {
      membersByName.set(member.name, { view: view.name, member });
    }
  }

  const measureNames = [...(query.measures ?? [])];
  const dimensionNames = [...(query.dimensions ?? [])];
  const segmentNames = [...(query.segments ?? [])];
  const timeDimensionNames = (query.timeDimensions ?? []).map((td) => td.dimension);
  const orderNames = Object.keys(query.order ?? {});
  const filterMembers: string[] = [];
  collectFilterMembers(query.filters, filterMembers);

  const allMembers = [
    ...measureNames,
    ...dimensionNames,
    ...segmentNames,
    ...timeDimensionNames,
    ...filterMembers,
    ...orderNames,
  ];
  if (allMembers.length === 0) {
    return { error: "The query must reference at least one measure, dimension, or time dimension." };
  }

  const unknown = allMembers.filter((name) => !membersByName.has(name));
  if (unknown.length > 0) {
    const viewNames = catalogue.views.map((view) => view.name).join(", ");
    return {
      error: `Unknown member${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. `
        + `Use fully qualified members from these views: ${viewNames}.`,
    };
  }

  const viewsUsed = new Set(allMembers.map((name) => membersByName.get(name)!.view));
  if (viewsUsed.size > 1) {
    return {
      error: `A single query must stay within one view; this one mixes ${[...viewsUsed].join(" and ")}. `
        + "Run one query per view and combine the results.",
    };
  }
  const viewName = [...viewsUsed][0]!;
  const selectedView = catalogue.views.find(({ name }) => name === viewName)!;

  for (const name of measureNames) {
    if (membersByName.get(name)!.member.kind !== "measure") {
      return { error: `${name} is not a measure.` };
    }
  }
  for (const name of dimensionNames) {
    if (membersByName.get(name)!.member.kind !== "dimension") {
      return { error: `${name} is not a dimension.` };
    }
  }
  for (const name of segmentNames) {
    if (membersByName.get(name)!.member.kind !== "segment") {
      return { error: `${name} is not a segment.` };
    }
  }
  for (const td of query.timeDimensions ?? []) {
    const entry = membersByName.get(td.dimension)!;
    if (entry.member.kind !== "dimension" || entry.member.type !== "time") {
      return { error: `${td.dimension} is not a time dimension.` };
    }
    if (td.granularity && !CUBE_GRANULARITIES.includes(td.granularity)) {
      return { error: `Granularity ${String(td.granularity)} is not supported.` };
    }
    if (td.compareDateRange) {
      if (td.compareDateRange.length < 2 || td.compareDateRange.length > 4) {
        return { error: "compareDateRange needs between two and four date ranges." };
      }
      if (td.compareDateRange.some((range) => explicitDateRange(range) === null)) {
        return {
          error: "Every compareDateRange entry must be a real ordered YYYY-MM-DD,YYYY-MM-DD pair.",
        };
      }
    }
    if (Array.isArray(td.dateRange) && explicitDateRange(td.dateRange) === null) {
      return { error: "An explicit dateRange must be a real ordered YYYY-MM-DD pair." };
    }
    // The same member as a bucketed time dimension *and* a plain dimension
    // makes Cube GROUP BY the raw timestamp as well: one row per distinct
    // second, so a "monthly" query with limit 12 returns twelve arbitrary
    // sales instead of twelve months (seen in production, 2026-08-19).
    if (td.granularity && dimensionNames.includes(td.dimension)) {
      return {
        error: `${td.dimension} is already a time dimension with granularity ${td.granularity}; `
          + "remove it from dimensions, or drop the granularity if you want individual timestamps.",
      };
    }
  }
  if (selectedView.queryPolicy === "aggregate_only") {
    if (measureNames.length === 0) {
      return {
        error: `${selectedView.name} is aggregate-only and requires at least one measure. `
          + "Individual source rows are not queryable.",
      };
    }
    if (selectedView.minimumGroupSize !== undefined) {
      if (!selectedView.populationMeasure) {
        return {
          error: `${selectedView.name} has an incomplete privacy policy and cannot be queried.`,
        };
      }
      const population = membersByName.get(selectedView.populationMeasure);
      if (!population || population.view !== selectedView.name || population.member.kind !== "measure") {
        return {
          error: `${selectedView.name} has an invalid privacy population measure and cannot be queried.`,
        };
      }
      if (!measureNames.includes(selectedView.populationMeasure)) {
        return {
          error: `${selectedView.name} requires ${selectedView.populationMeasure} in measures so groups below `
            + `${selectedView.minimumGroupSize} protected subjects can be rejected before results are retained.`,
        };
      }
    }
    for (const name of dimensionNames) {
      if (membersByName.get(name)!.member.type === "time") {
        return {
          error: `${name} cannot be selected as an exact dimension on an aggregate-only view. `
            + "Use it through timeDimensions with an approved granularity.",
        };
      }
    }
    for (const name of filterMembers) {
      const member = membersByName.get(name)!.member;
      if (member.type === "time") {
        return {
          error: `${name} cannot be filtered as an exact member on an aggregate-only view. `
            + "Use a dateRange on timeDimensions.",
        };
      }
      if (member.kind === "measure") {
        return {
          error: `${name} cannot be used as a measure filter on an aggregate-only view.`,
        };
      }
    }
    const minimumGranularity = selectedView.minimumTimeGranularity ?? "day";
    const minimumIndex = CUBE_GRANULARITIES.indexOf(minimumGranularity);
    for (const td of query.timeDimensions ?? []) {
      if (!td.granularity) {
        return {
          error: `${td.dimension} requires ${minimumGranularity}-or-coarser granularity `
            + "on this aggregate-only view.",
        };
      }
      if (CUBE_GRANULARITIES.indexOf(td.granularity) < minimumIndex) {
        return {
          error: `${td.dimension} requires ${minimumGranularity}-or-coarser granularity; `
            + `${td.granularity} is too precise.`,
        };
      }
    }
    for (const orderKey of orderNames) {
      if (membersByName.get(orderKey)!.member.type === "time") {
        return {
          error: `${orderKey} cannot order aggregate-only results by an exact timestamp.`,
        };
      }
    }
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_ROW_LIMIT)) {
    return { error: `limit must be an integer between 1 and ${MAX_ROW_LIMIT}.` };
  }

  const cubes = [...new Set(
    allMembers
      .map((name) => membersByName.get(name)!.member.aliasMember)
      .filter((alias): alias is string => Boolean(alias))
      .map((alias) => alias.split(".")[0]!),
  )];
  return {
    query: {
      ...query,
      limit: query.limit ?? DEFAULT_ROW_LIMIT,
      timezone: query.timezone ?? "Australia/Melbourne",
    },
    view: viewName,
    cubes,
    members: allMembers,
  };
}

/**
 * Rejects an entire protected result before it reaches model context, trace
 * persistence or dashboard replay when any returned group is below the
 * metadata-declared k threshold. Failing the full result avoids presenting a
 * silently incomplete total after suppressing only unsafe rows.
 */
export function enforceCubeResultPrivacy(
  result: CubeLoadResponse,
  view: CubeCatalogueView,
): CubeLoadResponse {
  if (!result.ok || view.minimumGroupSize === undefined) return result;
  if (!view.populationMeasure) {
    return {
      ok: false,
      error: `${view.name} has an incomplete privacy policy and its results were rejected.`,
      executionMs: result.executionMs,
    };
  }
  for (const row of result.rows) {
    const rawPopulation = row[view.populationMeasure];
    const population = typeof rawPopulation === "number"
      ? rawPopulation
      : typeof rawPopulation === "string" && rawPopulation.trim()
        ? Number(rawPopulation)
        : Number.NaN;
    if (!Number.isSafeInteger(population) || population < view.minimumGroupSize) {
      return {
        ok: false,
        error: `This aggregate is unavailable because at least one requested group has a missing/invalid `
          + `population or fewer than ${view.minimumGroupSize} protected subjects. `
          + "Use a broader date range or fewer breakdowns.",
        executionMs: result.executionMs,
      };
    }
  }
  return result;
}

/**
 * Minimal, dependency-free Cube REST client scoped to one tenant and turn.
 * Meta and query results are cached for the lifetime of the client (one
 * conversation turn in the engine).
 */
export class CubeClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private cataloguePromise: Promise<CubeCatalogue> | undefined;
  private readonly resultCache = new Map<string, CubeLoadResponse>();

  constructor(options: CubeClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/u, "");
    this.token = signCubeJwt({
      secret: options.apiSecret,
      securityContext: options.securityContext,
    });
    this.fetcher = options.fetcher ?? fetch;
  }

  async fetchCatalogue(signal?: AbortSignal): Promise<CubeCatalogue> {
    this.cataloguePromise ??= (async () => {
      const response = await this.fetcher(`${this.apiUrl}/cubejs-api/v1/meta`, {
        headers: { Authorization: this.token },
        signal: signal ?? null,
      });
      if (!response.ok) {
        this.cataloguePromise = undefined;
        throw new Error(`Cubecore is down. Cube meta request failed with HTTP ${response.status}.`);
      }
      return catalogueFromMeta(await response.json());
    })();
    return this.cataloguePromise;
  }

  /**
   * Validates and executes a Cube JSON query. Cube-side rejections come back
   * as `{ ok: false, error }` so the agent can self-correct instead of dying.
   */
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

    const cacheKey = cubeQueryHash(validated.query);
    const cached = this.resultCache.get(cacheKey);
    if (cached?.ok) {
      return { validated, result: { ...cached, cached: true } };
    }

    const selectedView = catalogue.views.find(({ name }) => name === validated.view)!;
    const result = enforceCubeResultPrivacy(
      await this.executeLoad(validated.query, started, options.signal),
      selectedView,
    );
    if (result.ok) this.resultCache.set(cacheKey, result);
    return { validated, result };
  }

  private async executeLoad(
    query: CubeQuery,
    started: number,
    signal?: AbortSignal,
  ): Promise<CubeLoadResponse> {
    // Cube rejects compareDateRange queries unless the request declares the
    // multi-result protocol; the response then arrives as a results array.
    const isCompareQuery = (query.timeDimensions ?? []).some((td) => td.compareDateRange?.length);
    while (Date.now() - started < CONTINUE_WAIT_TIMEOUT_MS) {
      if (signal?.aborted) {
        return { ok: false, error: "The query was cancelled.", executionMs: Date.now() - started };
      }
      let payload: unknown;
      let status: number;
      try {
        const url = new URL(`${this.apiUrl}/cubejs-api/v1/load`);
        url.searchParams.set("query", JSON.stringify(query));
        if (isCompareQuery) url.searchParams.set("queryType", "multi");
        const response = await this.fetcher(url, {
          headers: { Authorization: this.token },
          signal: signal ?? null,
        });
        status = response.status;
        payload = await response.json().catch(() => null);
      } catch (error) {
        return {
          ok: false,
          error: `Cubecore is down. The Cube API could not be reached (${error instanceof Error ? error.message : "network error"}).`,
          executionMs: Date.now() - started,
        };
      }

      const body = isRecord(payload) ? payload : {};
      if (body.error === "Continue wait") {
        await new Promise((resolve) => setTimeout(resolve, CONTINUE_WAIT_POLL_MS));
        continue;
      }
      if (status >= 500) {
        return {
          ok: false,
          error: typeof body.error === "string"
            ? `Cubecore is down. ${body.error}`
            : `Cubecore is down (HTTP ${status}).`,
          executionMs: Date.now() - started,
        };
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
        for (const entry of body.results as unknown[]) {
          if (!isRecord(entry)) continue;
          const rangeLabel = compareRangeLabel(entry.query);
          const entryRows = Array.isArray(entry.data) ? (entry.data as unknown[]).filter(isRecord) : [];
          for (const row of entryRows) {
            rows.push(rangeLabel && row.compareDateRange === undefined
              ? { ...row, compareDateRange: rangeLabel }
              : row);
          }
          mergeAnnotation(annotation, entry.annotation);
        }
        if (rows.some((row) => row.compareDateRange !== undefined)) {
          annotation.compareDateRange ??= {
            title: "Compared date range",
            shortTitle: "Date range",
            type: "string",
          };
        }
      } else {
        for (const row of Array.isArray(body.data) ? (body.data as unknown[]).filter(isRecord) : []) {
          rows.push(row);
        }
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

/** Human-readable date range for one result of a compareDateRange query. */
function compareRangeLabel(resultQuery: unknown): string | undefined {
  if (!isRecord(resultQuery) || !Array.isArray(resultQuery.timeDimensions)) return undefined;
  for (const td of resultQuery.timeDimensions as unknown[]) {
    if (!isRecord(td)) continue;
    const range = td.compareDateRange ?? td.dateRange;
    if (Array.isArray(range) && range.length === 2) {
      const [from, to] = range as unknown[];
      if (typeof from === "string" && typeof to === "string") {
        return `${from.slice(0, 10)} to ${to.slice(0, 10)}`;
      }
    }
    if (typeof range === "string") return range;
  }
  return undefined;
}

function mergeAnnotation(
  target: Record<string, { title: string; shortTitle: string; type: string; format?: string }>,
  annotationRaw: unknown,
): void {
  const source = isRecord(annotationRaw) ? annotationRaw : {};
  for (const group of ["measures", "dimensions", "timeDimensions", "segments"]) {
    const section = isRecord(source[group]) ? source[group] as Record<string, unknown> : {};
    for (const [member, info] of Object.entries(section)) {
      if (!isRecord(info) || target[member]) continue;
      target[member] = {
        title: asString(info.title) ?? member,
        shortTitle: asString(info.shortTitle) ?? member.split(".")[1] ?? member,
        type: asString(info.type) ?? "string",
        ...(asString(info.format) ? { format: asString(info.format) } : {}),
      };
    }
  }
}
