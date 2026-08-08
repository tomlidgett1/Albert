/**
 * Population-level completeness auditing for Xero streams.
 *
 * Xero identifies records by UUID, so Lightspeed-style id-window gap probing
 * does not apply. Completeness instead rests on three provable properties:
 *
 *   1. WINDOWS TILE — a time-windowed backfill's date windows must cover the
 *      requested history with no holes and no overlaps, or a record whose
 *      business date falls in a gap is silently never fetched.
 *   2. ORDERED DOUBLE PASS — page-number result sets are mutable; a walk only
 *      counts as complete when two consecutive ordered passes produce the
 *      same digest and count (the engine enforces it; the auditor proves the
 *      cursor actually carried it).
 *   3. FAN-OUT PARENT COVERAGE — a parent that advertises children
 *      (HasAttachments) must either have child rows or a recorded miss;
 *      a silent absence is a dropped sub-request, not an empty population.
 */

export type DateWindow = Readonly<{ from: string; to: string }>;

/**
 * Reject overlapping or holed backfill windows. Windows are half-open
 * [from, to): a window's `to` must equal the next window's `from` exactly.
 */
export function assertWindowsTile(windows: readonly DateWindow[]): void {
  const sorted = [...windows].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  for (const window of sorted) {
    if (!Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.to))) {
      throw new Error(`xero_completeness_window_invalid:${window.from}..${window.to}`);
    }
    if (Date.parse(window.from) >= Date.parse(window.to)) {
      throw new Error(`xero_completeness_window_empty:${window.from}..${window.to}`);
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (Date.parse(previous.to) < Date.parse(current.from)) {
      throw new Error(
        `xero_completeness_window_hole:${previous.to}..${current.from}: a record dated inside the hole is never fetched`,
      );
    }
    if (Date.parse(previous.to) > Date.parse(current.from)) {
      throw new Error(
        `xero_completeness_window_overlap:${current.from}..${previous.to}: overlapping windows double-count additive facts`,
      );
    }
  }
}

export type PassEvidence = Readonly<{
  scanDigest: string | undefined;
  scanCount: number | undefined;
  verificationDigest: string | undefined;
  verificationCount: number | undefined;
}>;

/**
 * A page-number walk is complete only when the verification pass reproduced
 * the scan pass exactly. Anything else is an unfinished walk being reported
 * as done.
 */
export function doublePassVerified(evidence: PassEvidence): boolean {
  if (evidence.scanDigest === undefined || evidence.scanCount === undefined) return false;
  return (
    evidence.verificationDigest === evidence.scanDigest &&
    evidence.verificationCount === evidence.scanCount
  );
}

export type FanOutParentObservation = Readonly<{
  parentId: string;
  /** The parent's own advertisement of children (HasAttachments); null when the parent has no such flag. */
  advertisesChildren: boolean | null;
  childRows: number;
  /** True when the sub-request was issued and returned empty/404 — a recorded miss, not a skip. */
  missRecorded: boolean;
}>;

export type FanOutCoverageReport = Readonly<{
  complete: boolean;
  silentAbsences: readonly string[];
  advertisedParents: number;
  coveredParents: number;
}>;

/**
 * Every parent that advertises children must have child rows or a recorded
 * miss. Parents that advertise nothing are legitimately skippable — skipping
 * them is what makes the fan-out affordable under the daily budget.
 */
export function auditFanOutCoverage(
  observations: readonly FanOutParentObservation[],
): FanOutCoverageReport {
  const silentAbsences: string[] = [];
  let advertisedParents = 0;
  let coveredParents = 0;
  for (const observation of observations) {
    if (observation.advertisesChildren === false) continue;
    advertisedParents += 1;
    if (observation.childRows > 0 || observation.missRecorded) {
      coveredParents += 1;
    } else {
      silentAbsences.push(observation.parentId);
    }
  }
  return {
    complete: silentAbsences.length === 0,
    silentAbsences,
    advertisedParents,
    coveredParents,
  };
}

/**
 * The journals feed is complete only when the walk reached an empty page AND
 * the recorded high journal number is monotonic across the whole walk. A
 * lower-than-cursor journal number means the vendor re-served history and the
 * walk cannot prove what it covered.
 */
export function journalsWalkComplete(input: Readonly<{
  lastPageEmpty: boolean;
  highJournalNumber: number | undefined;
  cursorOffset: number;
}>): boolean {
  if (!input.lastPageEmpty) return false;
  if (input.highJournalNumber === undefined) return input.cursorOffset === 0;
  return input.highJournalNumber >= input.cursorOffset;
}
