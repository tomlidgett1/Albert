/**
 * Element-level query overrides (ADR 0134): the owner's sort, filters and
 * row limit on one dashboard tile, expressed in the tile's own column keys
 * the way Sigma's column menu does it ("Sort ascending", "Filter").
 *
 * Overrides never touch the governed replay recipe. The refresh adapter
 * checks the recipe's digests first, then applies the overrides to the
 * validated base query and re-validates the effective query against the
 * live catalogue, so an override can only ever narrow or reorder a result
 * the tile was already allowed to show.
 */

import { CUBE_GRANULARITIES } from "@/packages/albert-v3/src/cube/types";
import type { CubeFilter, CubeQuery } from "@/packages/albert-v3/src/cube/types";
import {
  DASHBOARD_QUERY_FILTER_OPERATORS,
  dashboardQueryOverridesSchema,
  type DashboardQueryFilter,
  type DashboardQueryOrder,
  type DashboardQueryOverrides,
} from "@/services/control-plane/src/dashboard-repository";

export {
  DASHBOARD_QUERY_FILTER_OPERATORS,
  dashboardQueryOverridesSchema,
  type DashboardQueryFilter,
  type DashboardQueryOrder,
  type DashboardQueryOverrides,
};

export const EMPTY_DASHBOARD_QUERY_OVERRIDES: DashboardQueryOverrides = Object.freeze({});

export function dashboardQueryOverridesEmpty(overrides: DashboardQueryOverrides | undefined): boolean {
  if (!overrides) return true;
  return !(overrides.order?.length) && !(overrides.filters?.length) && overrides.limit === undefined;
}

/** Operators whose semantics need no value list. */
export function filterOperatorTakesValues(operator: DashboardQueryFilter["operator"]): boolean {
  return operator !== "set" && operator !== "notSet";
}

const GRANULARITY_SUFFIX = new RegExp(`[._](${CUBE_GRANULARITIES.join("|")})$`, "u");

/**
 * Resolves a snapshot column key to the query member it came from. Snapshot
 * keys are raw member names (`sales.gross_takings`), underscore spellings the
 * runtime publishes (`sales_gross_takings`), or bucketed time keys
 * (`sales.completed_at.week`); the member is always one the base query
 * already references.
 */
export function resolveOverrideMember(query: CubeQuery, columnKey: string): string | null {
  const members = [
    ...(query.measures ?? []),
    ...(query.dimensions ?? []),
    ...(query.timeDimensions ?? []).map((dimension) => dimension.dimension),
  ];
  const wanted = columnKey.trim();
  const bucketless = wanted.replace(GRANULARITY_SUFFIX, "");
  const underscored = (value: string) => value.replaceAll(".", "_");
  return members.find((member) => member === wanted)
    ?? members.find((member) => member === bucketless)
    ?? members.find((member) => underscored(member) === wanted)
    ?? members.find((member) => underscored(member) === underscored(bucketless))
    ?? null;
}

export type ApplyOverridesResult =
  | Readonly<{ ok: true; query: CubeQuery }>
  | Readonly<{ ok: false; error: string }>;

/**
 * The effective query a refresh runs: the validated base query with the
 * owner's sort replacing the base order, filters appended (AND), and the
 * limit narrowed. Unknown columns are an error, never silently dropped —
 * the tile shows why its refresh failed instead of showing the wrong rows.
 */
export function applyDashboardQueryOverrides(
  base: CubeQuery,
  overrides: DashboardQueryOverrides | undefined,
): ApplyOverridesResult {
  if (!overrides || dashboardQueryOverridesEmpty(overrides)) return { ok: true, query: base };
  let query: CubeQuery = base;
  if (overrides.order?.length) {
    const order: Record<string, "asc" | "desc"> = {};
    for (const entry of overrides.order) {
      const member = resolveOverrideMember(base, entry.column);
      if (!member) return { ok: false, error: `Sort column "${entry.column}" is not part of this element's query.` };
      order[member] = entry.direction;
    }
    query = { ...query, order };
  }
  if (overrides.filters?.length) {
    const appended: CubeFilter[] = [];
    for (const entry of overrides.filters) {
      const member = resolveOverrideMember(base, entry.column);
      if (!member) return { ok: false, error: `Filter column "${entry.column}" is not part of this element's query.` };
      const takesValues = filterOperatorTakesValues(entry.operator);
      const values = entry.values.map((value) => value.trim()).filter((value) => value.length > 0);
      if (takesValues && values.length === 0) {
        return { ok: false, error: `Filter on "${entry.column}" needs at least one value.` };
      }
      appended.push({
        member,
        operator: entry.operator,
        ...(takesValues ? { values } : {}),
      });
    }
    query = { ...query, filters: [...(query.filters ?? []), ...appended] };
  }
  if (overrides.limit !== undefined) {
    const current = query.limit;
    query = { ...query, limit: current === undefined ? overrides.limit : Math.min(current, overrides.limit) };
  }
  return { ok: true, query };
}
