import type { TraceTableColumn } from "../../../shared/src/index.js";
import type { CubeLoadResult } from "./types.js";

type CubeAnnotation = CubeLoadResult["annotation"][string] | undefined;

function validCurrency(currency: string | undefined): string | undefined {
  const normalized = currency?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}

/** Maps Cube's governed presentation metadata onto the durable trace contract. */
export function traceColumnFromCube(
  key: string,
  annotation: CubeAnnotation,
  currency?: string,
): TraceTableColumn {
  const format = annotation?.format?.trim().toLowerCase();
  const type: TraceTableColumn["type"] = format === "currency"
    ? "currency"
    : format === "percent"
      ? "percent"
      : annotation?.type === "number"
        ? "number"
        : annotation?.type === "time" || /(?:_at|_time|date)(?:\.[a-z]+)?$/u.test(key)
          ? "datetime"
          : "string";
  const currencyCode = type === "currency" ? validCurrency(currency) : undefined;
  return {
    key,
    label: annotation?.shortTitle ?? key.split(".")[1] ?? key,
    type,
    ...(currencyCode ? { currency: currencyCode } : {}),
    // Albert's Cube percentage measures explicitly multiply their ratio by
    // 100. Preserve that contract through every renderer and replay.
    ...(type === "percent" ? { percentScale: "percent" as const } : {}),
  };
}

// ---- Canonical column identity (ADR 0134) ----------------------------------
//
// A governed result's columns are identified ONE way everywhere a tile
// lives: the runtime trace, the pinned snapshot, every refresh, sealed
// derivations, presentation and overrides. Keys are the query members in
// QUERY order (measures, dimensions, time dimensions), deduplicated, spelled
// with underscores; two spellings of the same member (`sales.gross_takings`,
// `sales_gross_takings`, a bucketed `sales.completed_at.week`) are equal
// under `canonicalColumnKey`. Nothing derives column identity from the
// order Cube happens to return row keys in.

import type { CubeQuery } from "./types.js";

const GRANULARITY_SUFFIX = /[._](?:second|minute|hour|day|week|month|quarter|year)$/u;

/** The trace spelling of a Cube member: dots become underscores. */
export function publicColumnKey(member: string): string {
  return member.replaceAll(".", "_");
}

/** The identity under which every spelling of a member compares equal. */
export function canonicalColumnKey(key: string): string {
  return publicColumnKey(key.trim().replace(GRANULARITY_SUFFIX, ""));
}

export function columnKeysEquivalent(left: string, right: string): boolean {
  return left === right || canonicalColumnKey(left) === canonicalColumnKey(right);
}

/** The synthetic label column Cube adds to compareDateRange results. */
export const COMPARE_DATE_RANGE_KEY = "compareDateRange";

export type CubeResultColumns = Readonly<{
  /** Trace columns in query order, underscore keys, deduplicated. */
  columns: readonly TraceTableColumn[];
  /** The raw member behind each column (row values are read with it). */
  members: readonly string[];
}>;

/**
 * The columns a governed query result presents, in the query's own order:
 * measures, then dimensions, then time dimensions (once each, never the
 * filter or order members validation also lists), plus the compare label
 * when the rows carry one. A bucketed time dimension keeps Cube's
 * annotation for its bucket and is read from the plain member key Cube
 * mirrors alongside it.
 */
export function cubeResultColumns(
  query: CubeQuery,
  result: Pick<CubeLoadResult, "rows" | "annotation">,
  currency?: string,
): CubeResultColumns {
  const members: string[] = [];
  const seen = new Set<string>();
  const add = (member: string) => {
    if (seen.has(member)) return;
    seen.add(member);
    members.push(member);
  };
  for (const measure of query.measures ?? []) add(measure);
  for (const dimension of query.dimensions ?? []) add(dimension);
  // A dateRange without granularity filters the query; Cube does not return
  // that column. Including it creates a blank table field and an empty axis.
  for (const timeDimension of query.timeDimensions ?? []) {
    if (timeDimension.granularity) add(timeDimension.dimension);
  }
  const granularityByDimension = new Map(
    (query.timeDimensions ?? []).flatMap((entry) => entry.granularity ? [[entry.dimension, entry.granularity] as const] : []),
  );
  const columns: TraceTableColumn[] = members.map((member) => {
    const granularity = granularityByDimension.get(member);
    const annotation = result.annotation[member]
      ?? (granularity ? result.annotation[`${member}.${granularity}`] : undefined);
    return { ...traceColumnFromCube(member, annotation, currency), key: publicColumnKey(member) };
  });
  if (result.rows.some((row) => row[COMPARE_DATE_RANGE_KEY] !== undefined)) {
    members.push(COMPARE_DATE_RANGE_KEY);
    columns.push({ key: COMPARE_DATE_RANGE_KEY, label: "Date range", type: "string" });
  }
  return { columns, members };
}

export type AlignedColumns = Readonly<{
  columns: readonly TraceTableColumn[];
  /** For each aligned column, the fresh member whose value it shows. */
  members: readonly string[];
}>;

/**
 * Keeps a tile's columns where the owner last saw them. Every previous
 * column that still has an equivalent member keeps its key, label and
 * position (fresh type metadata is adopted); members with no previous
 * column are appended. Duplicate previous keys collapse to their first
 * occurrence, so a snapshot pinned with a doubled column heals itself.
 */
export function alignColumnsToPrevious(
  fresh: CubeResultColumns,
  previous: readonly Pick<TraceTableColumn, "key" | "label">[] | null | undefined,
): AlignedColumns {
  if (!previous || previous.length === 0) return fresh;
  const columns: TraceTableColumn[] = [];
  const members: string[] = [];
  const usedMembers = new Set<number>();
  const seenKeys = new Set<string>();
  for (const prior of previous) {
    if (seenKeys.has(prior.key)) continue;
    seenKeys.add(prior.key);
    const index = fresh.members.findIndex((member, position) => (
      !usedMembers.has(position) && columnKeysEquivalent(fresh.columns[position]!.key, prior.key)
    ));
    if (index < 0) continue;
    usedMembers.add(index);
    const current = fresh.columns[index]!;
    columns.push({ ...current, key: prior.key, label: prior.label });
    members.push(fresh.members[index]!);
  }
  fresh.members.forEach((member, position) => {
    if (usedMembers.has(position)) return;
    columns.push(fresh.columns[position]!);
    members.push(member);
  });
  return { columns, members };
}

export type RequeryAlignedColumns = AlignedColumns & Readonly<{
  /** Previous column key → the key it became (identity when unchanged). */
  renamed: ReadonlyMap<string, string>;
}>;

/**
 * Column alignment for a requery (migration 0187): the owner's column order
 * survives, but a member whose bucket changed ("Truncate date") takes its
 * fresh key and label, because the old spelling would lie about the data.
 * Members the edit removed fall away; members it added append. The
 * `renamed` map lets the caller carry presentation, display keys and
 * overrides across the re-spelling.
 */
export function alignColumnsForRequery(
  fresh: CubeResultColumns,
  previous: readonly Pick<TraceTableColumn, "key" | "label">[] | null | undefined,
): RequeryAlignedColumns {
  const renamed = new Map<string, string>();
  if (!previous || previous.length === 0) return { ...fresh, renamed };
  const columns: TraceTableColumn[] = [];
  const members: string[] = [];
  const usedMembers = new Set<number>();
  const seenKeys = new Set<string>();
  for (const prior of previous) {
    if (seenKeys.has(prior.key)) continue;
    seenKeys.add(prior.key);
    const exact = fresh.members.findIndex((_, position) => (
      !usedMembers.has(position) && fresh.columns[position]!.key === prior.key
    ));
    const index = exact >= 0 ? exact : fresh.members.findIndex((_, position) => (
      !usedMembers.has(position) && columnKeysEquivalent(fresh.columns[position]!.key, prior.key)
    ));
    if (index < 0) continue;
    usedMembers.add(index);
    const current = fresh.columns[index]!;
    // Same spelling: keep the owner's label (a rename lives in presentation,
    // but the trace label is theirs too). New spelling: fresh key and label.
    columns.push(exact >= 0 ? { ...current, label: prior.label } : current);
    members.push(fresh.members[index]!);
    renamed.set(prior.key, current.key);
  }
  fresh.members.forEach((member, position) => {
    if (usedMembers.has(position)) return;
    columns.push(fresh.columns[position]!);
    members.push(member);
  });
  return { columns, members, renamed };
}
