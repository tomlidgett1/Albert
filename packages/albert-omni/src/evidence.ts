import { createHash } from "node:crypto";
import type { ResultSemantics, TraceTableColumn } from "../../shared/src/index.js";
import type { CubeQuery } from "../../albert-v3/src/cube/types.js";
import { publicColumnKey } from "../../albert-v3/src/cube/presentation.js";

export function queryResultSemantics(input: Readonly<{
  query: CubeQuery;
  rowCount: number;
  retainedRows: number;
  columns: readonly TraceTableColumn[];
  connector: string;
  queryDigest: string;
  semanticVersionDigest: string;
  memberAliases?: ReadonlyMap<string, string>;
}>): ResultSemantics {
  const { query } = input;
  const rowLimit = query.limit ?? 500;
  const scalarAggregate = Boolean(query.measures?.length) && !query.dimensions?.length && !query.timeDimensions?.some((time) => time.granularity);
  const keys: Record<string, { kind: "identifier" | "period"; domain: string }> = {};
  for (const time of query.timeDimensions ?? []) {
    if (!time.granularity) continue;
    const key = input.columns.find((column) => column.key === publicColumnKey(time.dimension) || column.key === publicColumnKey(`${time.dimension}.${time.granularity}`))?.key;
    if (key) {
      keys[key] = { kind: "period", domain: `time:${query.timezone ?? "UTC"}:${time.granularity}` };
    }
  }
  for (const member of query.dimensions ?? []) {
    const key = publicColumnKey(member);
    // A source identifier is safe inside its own registered source domain.
    // Cross-source identity requires a declared mapping, never equal numbers.
    if (/(?:^|_)(?:id|uuid|sku|barcode)$/u.test(member.split(".").at(-1) ?? "")) {
      keys[key] = { kind: "identifier", domain: `${input.connector}:${input.memberAliases?.get(member) ?? member}` };
    }
  }
  return {
    version: 1,
    completeness: input.retainedRows < input.rowCount || (!scalarAggregate && input.rowCount >= rowLimit) ? "limited" : "complete",
    returnedRows: input.retainedRows,
    rowLimit,
    grain: [...(query.dimensions ?? []), ...(query.timeDimensions ?? []).flatMap((time) => time.granularity ? [`${time.dimension}.${time.granularity}`] : [])],
    keys,
    window: JSON.stringify({ timezone: query.timezone ?? "UTC", ranges: (query.timeDimensions ?? []).map((time) => ({ dateRange: time.dateRange ?? null, compareDateRange: time.compareDateRange ?? null })) }),
    queryDigest: input.queryDigest,
    semanticVersionDigest: input.semanticVersionDigest,
  };
}

export function derivedResultSemantics(
  sources: readonly Readonly<{ semantics?: ResultSemantics; rows: readonly unknown[] }>[],
  rowCount: number,
  recipe: string,
  keys: ResultSemantics["keys"] = sources[0]?.semantics?.keys ?? {},
  grain: readonly string[] = sources[0]?.semantics?.grain ?? [],
): ResultSemantics {
  return {
    version: 1,
    completeness: sources.every((source) => source.semantics?.completeness === "complete") ? "complete"
      : sources.some((source) => source.semantics?.completeness === "limited") ? "limited" : "unknown",
    returnedRows: rowCount,
    rowLimit: null,
    grain,
    keys,
    window: sources[0]?.semantics?.window ?? "unknown",
    queryDigest: createHash("sha256").update(recipe).digest("hex"),
    semanticVersionDigest: createHash("sha256").update(JSON.stringify(sources.map((source) => source.semantics?.semanticVersionDigest ?? "unknown"))).digest("hex"),
    qualifications: [...new Set(sources.flatMap((source) => source.semantics?.qualifications ?? []))].slice(0, 20),
    inputWindows: [...new Set(sources.flatMap((source) => [source.semantics?.window ?? "unknown", ...(source.semantics?.inputWindows ?? [])]))].slice(0, 30),
    inputGrains: [...new Map(sources.flatMap((source) => [source.semantics?.grain ?? [], ...(source.semantics?.inputGrains ?? [])]).map((grain) => [JSON.stringify(grain), grain])).values()].slice(0, 30),
  };
}
