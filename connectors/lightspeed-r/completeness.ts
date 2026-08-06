/**
 * Lightspeed R-Series completeness auditor.
 *
 * The pass mark is that every record the vendor holds is either staged or
 * provably absent. This turns that from a claim into an assertion.
 *
 * For a closed id window the set of ids that *should* have been considered is
 * known before the walk begins, so after the walk every id in the window falls
 * into exactly one bucket:
 *
 *   staged     the walk returned it
 *   deleted    a direct fetch also cannot find it, so it genuinely no longer exists
 *   MISSED     a direct fetch DOES find it, so the walk dropped a page
 *
 * The third bucket is the reason this exists. A dropped page is silent: the walk
 * reports success, the row count looks plausible, and the gap only surfaces
 * months later as a number that will not reconcile. Here it fails the run.
 *
 * Gap probing is cheap because gaps are sparse — ids are consumed by deletions,
 * not by losses — and up to 100 ids are resolved per request using the
 * documented `IN` operator.
 */
import type { ScanGroup } from "./scan-plan.js";
import type { FetchRequest } from "./fetch-core.js";

/** The documented ceiling on values passed to the `IN` operator. */
export const MAX_IN_VALUES = 100;

export type IdWindow = Readonly<{ from: number; to: number }>;

export type WindowObservation = Readonly<{
  window: IdWindow;
  /** Ids the walk actually returned within this window. */
  observedIds: readonly number[];
}>;

export type GapProbe = Readonly<{
  ids: readonly number[];
  request: FetchRequest;
}>;

export type CompletenessVerdict = Readonly<{
  resource: string;
  window: IdWindow;
  expectedSpan: number;
  staged: number;
  /** Ids absent from both the walk and a direct fetch: genuine deletions. */
  deleted: readonly number[];
  /** Ids a direct fetch resolved but the walk never returned. A walk defect. */
  missed: readonly number[];
  status: "complete" | "incomplete";
  detail: string;
}>;

/**
 * Ids inside the window that the walk did not return. Each is a candidate for
 * deletion, but candidacy is not evidence — only a direct fetch can tell a
 * deleted record from a dropped page.
 */
export function gapIds(observation: WindowObservation): readonly number[] {
  const { from, to } = observation.window;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const seen = new Set(observation.observedIds);
  const gaps: number[] = [];
  for (let id = from; id <= to; id += 1) if (!seen.has(id)) gaps.push(id);
  return gaps;
}

/**
 * Batch the gap ids into direct-fetch probes. Relations are deliberately not
 * requested: this asks only whether the record exists, and a lighter payload is
 * both faster and further from the documented memory-exhaustion 500.
 */
export function buildGapProbes(
  group: ScanGroup,
  ids: readonly number[],
  batchSize: number = MAX_IN_VALUES,
): readonly GapProbe[] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_IN_VALUES) {
    throw new Error(`Gap probe batch size must be between 1 and ${MAX_IN_VALUES}.`);
  }
  const probes: GapProbe[] = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize);
    probes.push({
      ids: batch,
      request: {
        path: group.path,
        params: {
          [group.idField]: `IN,[${batch.join(",")}]`,
          limit: String(Math.min(batch.length, MAX_IN_VALUES)),
        },
      },
    });
  }
  return probes;
}

/**
 * Classify a window once its gaps have been probed.
 *
 * `resolvedByProbe` is the set of ids a direct fetch returned. Anything the
 * probe resolved that the walk did not return is a walk defect, not a deletion,
 * and fails the window.
 */
export function classifyWindow(
  group: ScanGroup,
  observation: WindowObservation,
  resolvedByProbe: readonly number[],
): CompletenessVerdict {
  const { from, to } = observation.window;
  const expectedSpan = Math.max(0, to - from + 1);
  const observed = new Set(observation.observedIds);
  const resolved = new Set(resolvedByProbe);

  const gaps = gapIds(observation);
  const missed = gaps.filter((id) => resolved.has(id));
  const deleted = gaps.filter((id) => !resolved.has(id));

  const status = missed.length === 0 ? "complete" : "incomplete";
  const detail =
    status === "complete"
      ? `${observed.size} staged, ${deleted.length} confirmed deleted across ids ${from}-${to}.`
      : `${missed.length} id(s) resolve by direct fetch but were never returned by the walk ` +
        `(first: ${missed.slice(0, 10).join(", ")}). A page was dropped; the window must be re-run.`;

  return {
    resource: group.resource,
    window: observation.window,
    expectedSpan,
    staged: observed.size,
    deleted,
    missed,
    status,
    detail,
  };
}

export type ResourceAudit = Readonly<{
  resource: string;
  windows: readonly CompletenessVerdict[];
  totalStaged: number;
  totalDeleted: number;
  totalMissed: number;
  status: "complete" | "incomplete";
  /** Populations the vendor is documented to hide but does not actually expose. */
  knownGaps: readonly string[];
}>;

/**
 * Documented populations that cannot be reached, recorded rather than silently
 * treated as empty. `Sale` accepts the `archived` parameter and ignores it: the
 * same ids come back either way, so archived sales are unreachable through the
 * public API. Reporting zero archived sales as fact would be a lie; reporting
 * the limitation is not.
 */
const KNOWN_UNREACHABLE: Readonly<Record<string, readonly string[]>> = {
  Sale: [
    "Archived sales are unreachable: the documented `archived` filter is accepted but " +
      "returns the identical id set, so this connector cannot enumerate them.",
  ],
};

export function auditResource(
  group: ScanGroup,
  verdicts: readonly CompletenessVerdict[],
): ResourceAudit {
  const totalStaged = verdicts.reduce((sum, v) => sum + v.staged, 0);
  const totalDeleted = verdicts.reduce((sum, v) => sum + v.deleted.length, 0);
  const totalMissed = verdicts.reduce((sum, v) => sum + v.missed.length, 0);
  return {
    resource: group.resource,
    windows: verdicts,
    totalStaged,
    totalDeleted,
    totalMissed,
    status: totalMissed === 0 ? "complete" : "incomplete",
    knownGaps: KNOWN_UNREACHABLE[group.resource] ?? [],
  };
}

/**
 * Windows must tile the discovered id range exactly: no overlap, no hole. An
 * overlap double-stages; a hole is an unexamined region that no later check
 * would ever look at.
 */
export function assertWindowsTile(
  windows: readonly IdWindow[],
  minId: number,
  maxId: number,
): void {
  if (windows.length === 0) {
    if (maxId >= minId) {
      throw new Error(`No windows cover ids ${minId}-${maxId}; the resource would go unscanned.`);
    }
    return;
  }
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  if (sorted[0].from !== minId) {
    throw new Error(`Windows start at ${sorted[0].from} but the id range starts at ${minId}.`);
  }
  if (sorted[sorted.length - 1].to !== maxId) {
    throw new Error(
      `Windows end at ${sorted[sorted.length - 1].to} but the id range ends at ${maxId}.`,
    );
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.from <= previous.to) {
      throw new Error(
        `Windows ${previous.from}-${previous.to} and ${current.from}-${current.to} overlap; ` +
          `records in the overlap would be staged twice.`,
      );
    }
    if (current.from !== previous.to + 1) {
      throw new Error(
        `Ids ${previous.to + 1}-${current.from - 1} fall between windows and would never be scanned.`,
      );
    }
  }
}

/**
 * Cross-check the referential closure a walk should satisfy: every foreign key
 * observed in a child table must resolve in its parent. Orphans mean a parent
 * population was missed, which is almost always an unswept archived set.
 */
export function findOrphans(
  childKeys: readonly (string | number)[],
  parentKeys: readonly (string | number)[],
): readonly string[] {
  const parents = new Set(parentKeys.map((k) => String(k)));
  const orphans = new Set<string>();
  for (const key of childKeys) {
    const text = String(key);
    if (text.length > 0 && text !== "0" && !parents.has(text)) orphans.add(text);
  }
  return [...orphans];
}
