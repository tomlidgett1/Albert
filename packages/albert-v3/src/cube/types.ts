/**
 * Cube JSON query contracts for the Albert v3 engine.
 *
 * The engine only ever speaks Cube's semantic query language. There is no SQL
 * anywhere in this package: Cube compiles these queries server-side under the
 * tenant's security context.
 */

export const CUBE_GRANULARITIES = [
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;

export type CubeGranularity = (typeof CUBE_GRANULARITIES)[number];

export type CubeFilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "startsWith"
  | "notStartsWith"
  | "endsWith"
  | "notEndsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "set"
  | "notSet"
  | "inDateRange"
  | "notInDateRange"
  | "beforeDate"
  | "afterDate";

export type CubeMemberFilter = Readonly<{
  member: string;
  operator: CubeFilterOperator;
  values?: readonly string[];
}>;

export type CubeFilter =
  | CubeMemberFilter
  | Readonly<{ and: readonly CubeFilter[] }>
  | Readonly<{ or: readonly CubeFilter[] }>;

export type CubeTimeDimension = Readonly<{
  dimension: string;
  granularity?: CubeGranularity;
  dateRange?: string | readonly [string, string];
  compareDateRange?: readonly (string | readonly [string, string])[];
}>;

export type CubeQuery = Readonly<{
  measures?: readonly string[];
  dimensions?: readonly string[];
  segments?: readonly string[];
  timeDimensions?: readonly CubeTimeDimension[];
  filters?: readonly CubeFilter[];
  order?: Readonly<Record<string, "asc" | "desc">>;
  limit?: number;
  offset?: number;
  timezone?: string;
}>;

export type CubeMemberType = "string" | "number" | "boolean" | "time";

export type CubeCatalogueMember = Readonly<{
  /** Fully qualified name, for example `sales_analytics.gross_takings`. */
  name: string;
  kind: "measure" | "dimension" | "segment";
  title: string;
  shortTitle: string;
  description?: string;
  type?: CubeMemberType;
  aiContext?: string;
  /** Queryable for replay/validation but omitted from every model-facing catalogue surface. */
  aiHidden?: boolean;
  folder?: string;
  /** For view members, the underlying cube member the view aliases. */
  aliasMember?: string;
}>;

export type CubeCatalogueView = Readonly<{
  name: string;
  title: string;
  description?: string;
  aiContext?: string;
  /**
   * Generic, model-owned policy published by a semantic view. `aggregate_only`
   * prevents row-grain dimensions and exact time from reaching replayable
   * result artefacts even when the agent submits a syntactically valid query.
   */
  queryPolicy?: "aggregate_only";
  minimumTimeGranularity?: CubeGranularity;
  /** Minimum protected subjects contributing to every returned aggregate cell. */
  minimumGroupSize?: number;
  /** Fully-qualified count-distinct measure used to enforce minimumGroupSize. */
  populationMeasure?: string;
  members: readonly CubeCatalogueMember[];
}>;

export type CubeCatalogue = Readonly<{
  views: readonly CubeCatalogueView[];
  fetchedAt: string;
}>;

export type CubeLoadResult = Readonly<{
  ok: true;
  rows: readonly Readonly<Record<string, unknown>>[];
  /** Column annotations keyed by member name (title, type, format). */
  annotation: Readonly<Record<string, Readonly<{
    title: string;
    shortTitle: string;
    type: string;
    format?: string;
  }>>>;
  executionMs: number;
  /** True when this result was served from the per-turn client cache. */
  cached: boolean;
}>;

export type CubeLoadFailure = Readonly<{
  ok: false;
  /** A recoverable, model-safe description of what Cube rejected. */
  error: string;
  executionMs: number;
}>;

export type CubeLoadResponse = CubeLoadResult | CubeLoadFailure;

export type CubeSecurityContext = Readonly<{
  tenant_id: string;
  role?: "owner" | "manager" | "bookkeeper" | "internal_operator";
  specialist_agent_id?: "general" | "customers";
  specialist_agent_version?: number;
}> & (
  | Readonly<{
    conversation_id: string;
    turn_id: string;
    dashboard_tile_id?: never;
    dashboard_refresh_lease_id?: never;
  }>
  | Readonly<{
    dashboard_tile_id: string;
    dashboard_refresh_lease_id: string;
    conversation_id?: never;
    turn_id?: never;
  }>
);
