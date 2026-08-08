/**
 * The Xero coverage proof, computed rather than asserted.
 *
 * `field-census.json` is the immutable denominator: every read-reachable field
 * of the official XeroAPI/Xero-OpenAPI specifications at the pinned revision,
 * extracted mechanically and committed so this proof runs offline. `tables.json`
 * is the numerator: the semantic dictionary the connector compiles against.
 *
 * A field is accounted for when a column cites it, a jsonb column declares it in
 * `coversNested`, or the artifact's own ledgers explain it — `exclusions` (a
 * surface Albert deliberately does not ingest, with the reason) or `unaccounted`
 * (a field no table maps, with the reason). Anything else is MISSING, and a
 * missing field is a build failure: it is exactly the silent gap that turns
 * "we ingest your Xero data" into a lie.
 */
import censusJson from "./field-census.json" with { type: "json" };
import tablesJson from "./tables.json" with { type: "json" };

type SchemaGraph = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string | null>>>>>>;

export type XeroFieldCensus = Readonly<{
  revision: string;
  specs: readonly Readonly<{ api: string; readOperations: number; objects: number; fields: number }>[];
  totals: Readonly<{ readOperations: number; objects: number; fields: number }>;
  fields: readonly string[];
  schemaGraph: SchemaGraph;
}>;

export const XERO_FIELD_CENSUS = censusJson as unknown as XeroFieldCensus;

type SpecArtifact = Readonly<{
  generatedFrom: string;
  tables: readonly Readonly<{
    id: string;
    columns: readonly Readonly<{ name: string; api: string; coversNested?: readonly string[] }>[];
  }>[];
  exclusions?: readonly Readonly<{ api: string; pattern: string; reason: string }>[];
  unaccounted?: readonly Readonly<{ field: string; reason: string }>[];
}>;

const artifact = tablesJson as unknown as SpecArtifact;

export type XeroCoverageReport = Readonly<{
  fields: number;
  mapped: number;
  excluded: number;
  unaccounted: number;
  missing: readonly string[];
  tables: number;
  columns: number;
  /** Percentage of the census that is explicitly accounted for. */
  pct: string;
  /** Citations that do not resolve against the census — invented provenance. */
  unresolvable: readonly string[];
}>;

/**
 * Resolve one provenance citation against the census graph, returning every
 * census field it traverses. A citation that cannot be resolved is invented
 * provenance and is reported rather than silently ignored.
 */
function resolveCitation(
  citation: string,
  census: XeroFieldCensus,
  covered: Set<string>,
  unresolvable: string[],
  where: string,
): void {
  if (citation.startsWith("synthetic:")) return;
  const separator = citation.indexOf(":");
  const api = citation.slice(0, separator);
  const graph = census.schemaGraph[api];
  if (!graph) {
    unresolvable.push(`${where}: unknown api "${api}" in "${citation}"`);
    return;
  }
  const path = citation.slice(separator + 1).replace(/\[\]( index)?$/u, "").split(".");
  let current = path[0]!;
  for (let index = 1; index < path.length; index += 1) {
    const fields = graph[current];
    if (!fields) {
      unresolvable.push(`${where}: object "${api}:${current}" is not in the census ("${citation}")`);
      return;
    }
    const segment = path[index]!;
    if (!(segment in fields)) {
      unresolvable.push(`${where}: field "${api}:${current}.${segment}" is not in the census ("${citation}")`);
      return;
    }
    covered.add(`${api}:${current}.${segment}`);
    if (index < path.length - 1) {
      const next = fields[segment];
      if (!next) {
        unresolvable.push(`${where}: "${api}:${current}.${segment}" is scalar but "${citation}" descends further`);
        return;
      }
      current = next;
    }
  }
}

export function computeXeroCoverage(
  census: XeroFieldCensus = XERO_FIELD_CENSUS,
  spec: SpecArtifact = artifact,
): XeroCoverageReport {
  const covered = new Set<string>();
  const unresolvable: string[] = [];
  const censusFields = new Set(census.fields);

  for (const table of spec.tables) {
    for (const column of table.columns) {
      resolveCitation(column.api, census, covered, unresolvable, `${table.id}.${column.name}`);
      for (const nested of column.coversNested ?? []) {
        if (!censusFields.has(nested)) {
          unresolvable.push(`${table.id}.${column.name}: coversNested cites "${nested}", which is not in the census`);
          continue;
        }
        covered.add(nested);
      }
    }
  }

  const excluded = new Set<string>();
  for (const entry of spec.exclusions ?? []) {
    const [objectPattern, fieldPattern] = entry.pattern.split(".");
    for (const field of census.fields) {
      const separator = field.indexOf(":");
      if (field.slice(0, separator) !== entry.api) continue;
      const rest = field.slice(separator + 1);
      const object = rest.slice(0, rest.lastIndexOf("."));
      const name = rest.slice(rest.lastIndexOf(".") + 1);
      if (object === objectPattern && (fieldPattern === "*" || fieldPattern === name)) excluded.add(field);
    }
  }
  const unaccounted = new Set((spec.unaccounted ?? []).map((entry) => entry.field));

  const missing = census.fields.filter(
    (field) => !covered.has(field) && !excluded.has(field) && !unaccounted.has(field),
  );
  const accounted = census.fields.length - missing.length;

  return {
    fields: census.fields.length,
    mapped: census.fields.filter((field) => covered.has(field)).length,
    excluded: [...excluded].filter((field) => !covered.has(field)).length,
    unaccounted: [...unaccounted].filter((field) => !covered.has(field) && !excluded.has(field)).length,
    missing,
    tables: spec.tables.length,
    columns: spec.tables.reduce((total, table) => total + table.columns.length, 0),
    pct: ((100 * accounted) / census.fields.length).toFixed(1),
    unresolvable,
  };
}

export const XERO_COVERAGE: XeroCoverageReport = computeXeroCoverage();
