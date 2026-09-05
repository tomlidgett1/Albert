import { SQUARE_SDK_FIELD_CENSUS } from "./field-census.generated.js";
import type { SquareCensusShape, SquareSdkFieldCensus } from "./field-census-types.js";
import { SQUARE_READ_STREAMS } from "./streams.js";

/** Typed view prevents consumers from depending on the generated literal's shape. */
export const SQUARE_FIELD_CENSUS: SquareSdkFieldCensus = SQUARE_SDK_FIELD_CENSUS;

export type SquareCensusPath = Readonly<{
  path: string;
  kind: "scalar" | "unknown" | "object" | "array" | "map" | "union" | "cycle";
  optional: boolean;
  sourceModel: string;
}>;

function shapeKind(shape: SquareCensusShape): SquareCensusPath["kind"] {
  if (shape.kind === "reference" || shape.kind === "intersection") return "object";
  return shape.kind;
}

function appendField(prefix: string, field: string): string {
  if (field === "{*}") return `${prefix}{*}`;
  return prefix ? `${prefix}.${field}` : field;
}

/**
 * Expand every direct and transitive SDK wire field under a selected entity.
 * Recursive model edges are represented by a `cycle` row after all fields on
 * the first visit have been emitted; no field is silently dropped.
 */
export function squareCensusPaths(rootEntity: string): readonly SquareCensusPath[] {
  if (!SQUARE_FIELD_CENSUS.models[rootEntity]) {
    throw new Error(`Unknown Square census root ${rootEntity}.`);
  }
  const rows = new Map<string, SquareCensusPath>();
  const put = (row: SquareCensusPath): void => {
    const key = `${row.path}\u0000${row.kind}\u0000${row.sourceModel}`;
    if (!rows.has(key)) rows.set(key, row);
  };

  const visit = (
    shape: SquareCensusShape,
    path: string,
    optional: boolean,
    sourceModel: string,
    ancestors: ReadonlySet<string>,
  ): void => {
    switch (shape.kind) {
      case "scalar":
      case "unknown":
        if (path) put({ path, kind: shape.kind, optional, sourceModel });
        return;
      case "array": {
        if (path) put({ path, kind: "array", optional, sourceModel });
        visit(shape.item, `${path}[]`, optional, sourceModel, ancestors);
        return;
      }
      case "map": {
        if (path) put({ path, kind: "map", optional, sourceModel });
        visit(shape.value, appendField(path, "{*}"), optional, sourceModel, ancestors);
        return;
      }
      case "union":
        if (path) put({ path, kind: "union", optional, sourceModel });
        for (const option of shape.options) visit(option, path, optional, sourceModel, ancestors);
        return;
      case "intersection":
        for (const part of shape.parts) visit(part, path, optional, sourceModel, ancestors);
        return;
      case "object":
        if (path) put({ path, kind: "object", optional, sourceModel });
        for (const field of shape.fields) {
          const fieldPath = appendField(path, field.name);
          put({ path: fieldPath, kind: shapeKind(field.shape), optional: optional || field.optional, sourceModel });
          visit(field.shape, fieldPath, optional || field.optional, sourceModel, ancestors);
        }
        return;
      case "reference": {
        if (ancestors.has(shape.target)) {
          if (path) put({ path, kind: "cycle", optional, sourceModel: shape.target });
          return;
        }
        const target = SQUARE_FIELD_CENSUS.models[shape.target];
        if (!target) throw new Error(`Square census reference ${shape.target} is unresolved.`);
        const next = new Set(ancestors);
        next.add(shape.target);
        visit(target.shape, path, optional, shape.target, next);
      }
    }
  };

  const root = SQUARE_FIELD_CENSUS.models[rootEntity]!;
  visit(root.shape, "", false, rootEntity, new Set([rootEntity]));
  return Object.freeze([...rows.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind) || left.sourceModel.localeCompare(right.sourceModel),
  ));
}

export function squareCensusReferences(shape: SquareCensusShape, found = new Set<string>()): ReadonlySet<string> {
  switch (shape.kind) {
    case "reference": found.add(shape.target); break;
    case "array": squareCensusReferences(shape.item, found); break;
    case "map": squareCensusReferences(shape.value, found); break;
    case "object": for (const field of shape.fields) squareCensusReferences(field.shape, found); break;
    case "union": for (const option of shape.options) squareCensusReferences(option, found); break;
    case "intersection": for (const part of shape.parts) squareCensusReferences(part, found); break;
    default: break;
  }
  return found;
}

export function squareTransitiveModels(rootEntity: string): readonly string[] {
  const visited = new Set<string>();
  const queue = [rootEntity];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    const model = SQUARE_FIELD_CENSUS.models[name];
    if (!model) throw new Error(`Square census model ${name} is unresolved.`);
    visited.add(name);
    for (const reference of squareCensusReferences(model.shape)) queue.push(reference);
  }
  return Object.freeze([...visited].sort());
}

export type SquareStreamFieldCoverage = Readonly<{
  stream: string;
  rootEntity: string;
  transitiveModels: readonly string[];
  paths: readonly SquareCensusPath[];
  disposition: "governed_source_extension";
  rawEscapeHatch: "immutable_raw_json_and_runtime_field_index";
}>;

/** A complete source-specific coverage view; canonical disposition is layered separately. */
export function squareStreamFieldCoverage(streamId: string): SquareStreamFieldCoverage {
  const stream = SQUARE_READ_STREAMS.find((candidate) => candidate.id === streamId);
  if (!stream) throw new Error(`Unknown Square stream ${streamId}.`);
  return Object.freeze({
    stream: stream.id,
    rootEntity: stream.rootEntity,
    transitiveModels: squareTransitiveModels(stream.rootEntity),
    paths: squareCensusPaths(stream.rootEntity),
    disposition: "governed_source_extension",
    rawEscapeHatch: "immutable_raw_json_and_runtime_field_index",
  });
}

export type SquareRuntimeField = Readonly<{
  path: string;
  kinds: readonly ("null" | "boolean" | "number" | "string" | "array" | "object")[];
  occurrences: number;
  documentedByPinnedSdk: boolean;
}>;

export type SquareRuntimeFieldIndex = Readonly<{
  rootEntity: string;
  fields: readonly SquareRuntimeField[];
  undocumentedPaths: readonly string[];
  truncated: boolean;
  rawPayloadPolicy: "immutable_required";
  semanticDisposition: "exploratory_until_reviewed";
}>;

function runtimeKind(value: unknown): SquareRuntimeField["kinds"][number] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "object";
}

function escapedRuntimeField(prefix: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? appendField(prefix, key)
    : `${prefix}[${JSON.stringify(key)}]`;
}

function patternFor(path: string): RegExp {
  const wildcardToken = "__SQUARE_MAP_KEY__";
  const escaped = path
    .replaceAll("{*}", wildcardToken)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(wildcardToken, "(?:[^.\\[]+|\\[\"(?:\\\\.|[^\"])*\"\\])");
  return new RegExp(`^${escaped}(?:$|[.\\[])`);
}

/**
 * Index fields observed in a real payload without retaining values.
 *
 * This is the additive-schema escape hatch: every wire key, including a field
 * introduced after the pin or a seller-defined map key, remains addressable in
 * immutable raw JSON immediately. Unknown fields are Exploratory until the
 * monthly SDK/docs diff assigns a curated semantic disposition.
 */
export function buildSquareRuntimeFieldIndex(
  rootEntity: string,
  value: unknown,
  limits: Readonly<{ maxDepth?: number; maxNodes?: number }> = {},
): SquareRuntimeFieldIndex {
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 100_000;
  const documented = squareCensusPaths(rootEntity);
  const exact = new Set(documented.map((row) => row.path));
  const wildcardPatterns = documented.filter((row) => row.path.includes("{*}")).map((row) => patternFor(row.path));
  const opaquePrefixes = documented.filter((row) => row.kind === "unknown").map((row) => patternFor(row.path));
  const observed = new Map<string, { kinds: Set<SquareRuntimeField["kinds"][number]>; occurrences: number }>();
  let nodes = 0;
  let truncated = false;

  const add = (path: string, current: unknown): void => {
    if (!path) return;
    const row = observed.get(path) ?? { kinds: new Set(), occurrences: 0 };
    row.kinds.add(runtimeKind(current));
    row.occurrences += 1;
    observed.set(path, row);
  };
  const visit = (current: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) { truncated = true; return; }
    add(path, current);
    if (Array.isArray(current)) {
      for (const child of current) visit(child, `${path}[]`, depth + 1);
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        visit(child, escapedRuntimeField(path, key), depth + 1);
      }
    }
  };
  visit(value, "", 0);

  const isDocumented = (path: string): boolean =>
    exact.has(path) || wildcardPatterns.some((pattern) => pattern.test(path)) || opaquePrefixes.some((pattern) => pattern.test(path));
  const fields = [...observed.entries()].map(([path, row]) => Object.freeze({
    path,
    kinds: Object.freeze([...row.kinds].sort()),
    occurrences: row.occurrences,
    documentedByPinnedSdk: isDocumented(path),
  })).sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    rootEntity,
    fields: Object.freeze(fields),
    undocumentedPaths: Object.freeze(fields.filter((field) => !field.documentedByPinnedSdk).map((field) => field.path)),
    truncated,
    rawPayloadPolicy: "immutable_required",
    semanticDisposition: "exploratory_until_reviewed",
  });
}
