import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWindowsTile,
  auditFanOutCoverage,
  doublePassVerified,
  journalsWalkComplete,
} from "../../connectors/xero/completeness.js";

test("tiled windows pass; holes and overlaps are named failures", () => {
  assert.doesNotThrow(() => assertWindowsTile([
    { from: "2024-01-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" },
    { from: "2025-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
  ]));
  assert.throws(() => assertWindowsTile([
    { from: "2024-01-01T00:00:00.000Z", to: "2024-06-01T00:00:00.000Z" },
    { from: "2024-07-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" },
  ]), /window_hole/u, "a record dated in June is silently unfetchable");
  assert.throws(() => assertWindowsTile([
    { from: "2024-01-01T00:00:00.000Z", to: "2024-08-01T00:00:00.000Z" },
    { from: "2024-07-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" },
  ]), /window_overlap/u, "overlap double-counts additive facts");
  assert.throws(() => assertWindowsTile([
    { from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z" },
  ]), /window_empty/u);
});

test("a walk is complete only when the verification pass reproduces the scan", () => {
  assert.equal(doublePassVerified({
    scanDigest: "a".repeat(64), scanCount: 42,
    verificationDigest: "a".repeat(64), verificationCount: 42,
  }), true);
  assert.equal(doublePassVerified({
    scanDigest: "a".repeat(64), scanCount: 42,
    verificationDigest: "b".repeat(64), verificationCount: 42,
  }), false, "a differing digest is a mutated result set, not a finished walk");
  assert.equal(doublePassVerified({
    scanDigest: "a".repeat(64), scanCount: 42,
    verificationDigest: "a".repeat(64), verificationCount: 41,
  }), false);
  assert.equal(doublePassVerified({
    scanDigest: undefined, scanCount: undefined,
    verificationDigest: undefined, verificationCount: undefined,
  }), false);
});

test("advertised children must be fetched or recorded as missed — never skipped silently", () => {
  const report = auditFanOutCoverage([
    { parentId: "inv-1", advertisesChildren: true, childRows: 3, missRecorded: false },
    { parentId: "inv-2", advertisesChildren: true, childRows: 0, missRecorded: true },
    { parentId: "inv-3", advertisesChildren: false, childRows: 0, missRecorded: false },
    { parentId: "inv-4", advertisesChildren: true, childRows: 0, missRecorded: false },
    { parentId: "inv-5", advertisesChildren: null, childRows: 0, missRecorded: true },
  ]);
  assert.equal(report.complete, false);
  assert.deepEqual(report.silentAbsences, ["inv-4"]);
  assert.equal(report.advertisedParents, 4, "flagless parents count as advertised — absence of a flag is not permission to skip");
  assert.equal(report.coveredParents, 3);
});

test("the journals walk proves completion by empty page plus monotonic offset", () => {
  assert.equal(journalsWalkComplete({ lastPageEmpty: true, highJournalNumber: 900, cursorOffset: 900 }), true);
  assert.equal(journalsWalkComplete({ lastPageEmpty: false, highJournalNumber: 900, cursorOffset: 900 }), false);
  assert.equal(journalsWalkComplete({ lastPageEmpty: true, highJournalNumber: 880, cursorOffset: 900 }), false,
    "a re-served lower journal number cannot prove coverage");
  assert.equal(journalsWalkComplete({ lastPageEmpty: true, highJournalNumber: undefined, cursorOffset: 0 }), true,
    "an empty ledger is complete at offset zero");
});
