import assert from "node:assert/strict";
import test from "node:test";
import { buildScanPlan, shardIdRange } from "../../connectors/lightspeed-r/scan-plan.js";
import {
  MAX_IN_VALUES,
  assertWindowsTile,
  auditResource,
  buildGapProbes,
  classifyWindow,
  findOrphans,
  gapIds,
} from "../../connectors/lightspeed-r/completeness.js";

const plan = buildScanPlan();
const sale = plan.groups.find((g) => g.resource === "Sale")!;
const window = { from: 1, to: 10 };

test("gaps are the ids the walk did not return", () => {
  assert.deepEqual(gapIds({ window, observedIds: [1, 2, 3, 5, 6, 7, 8, 9, 10] }), [4]);
  assert.deepEqual(gapIds({ window, observedIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), []);
  assert.deepEqual(gapIds({ window: { from: 5, to: 1 }, observedIds: [] }), [],
    "an inverted window yields no work rather than a huge loop");
});

test("a gap that a direct fetch cannot resolve is a deletion, and the window passes", () => {
  const verdict = classifyWindow(sale, { window, observedIds: [1, 2, 3, 5, 6, 7, 8, 9, 10] }, []);
  assert.equal(verdict.status, "complete");
  assert.deepEqual(verdict.deleted, [4]);
  assert.deepEqual(verdict.missed, []);
  assert.equal(verdict.staged, 9);
});

test("a gap that a direct fetch DOES resolve is a dropped page, and fails the window", () => {
  // The silent killer: the walk succeeded, the count looked plausible, but id 4
  // exists and was never returned.
  const verdict = classifyWindow(sale, { window, observedIds: [1, 2, 3, 5, 6, 7, 8, 9, 10] }, [4]);
  assert.equal(verdict.status, "incomplete");
  assert.deepEqual(verdict.missed, [4]);
  assert.deepEqual(verdict.deleted, []);
  assert.match(verdict.detail, /page was dropped/);
});

test("deletions and dropped pages are separated within one window", () => {
  const verdict = classifyWindow(
    sale,
    { window, observedIds: [1, 2, 5, 6, 7, 8, 9, 10] },
    [3], // 3 exists and was missed; 4 genuinely does not exist
  );
  assert.deepEqual(verdict.missed, [3]);
  assert.deepEqual(verdict.deleted, [4]);
  assert.equal(verdict.status, "incomplete");
});

test("gap probes batch at the documented IN ceiling and ask only for existence", () => {
  const ids = Array.from({ length: 250 }, (_, i) => i + 1);
  const probes = buildGapProbes(sale, ids);
  assert.equal(probes.length, 3, "250 ids resolve in three requests, not 250");
  assert.equal(probes[0].ids.length, MAX_IN_VALUES);
  assert.equal(probes[2].ids.length, 50);
  assert.match(probes[0].request.params.saleID, /^IN,\[1,2,3,/);
  assert.equal(probes[0].request.params.load_relations, undefined,
    "an existence probe must not drag child payloads");
  assert.throws(() => buildGapProbes(sale, ids, 0), /between 1 and 100/);
  assert.throws(() => buildGapProbes(sale, ids, 500), /between 1 and 100/);
  assert.deepEqual(buildGapProbes(sale, []), []);
});

test("a resource is complete only when no window dropped a page", () => {
  const clean = auditResource(sale, [
    classifyWindow(sale, { window: { from: 1, to: 5 }, observedIds: [1, 2, 3, 4, 5] }, []),
    classifyWindow(sale, { window: { from: 6, to: 10 }, observedIds: [6, 7, 9, 10] }, []),
  ]);
  assert.equal(clean.status, "complete");
  assert.equal(clean.totalStaged, 9);
  assert.equal(clean.totalDeleted, 1);

  const broken = auditResource(sale, [
    classifyWindow(sale, { window: { from: 1, to: 5 }, observedIds: [1, 2, 4, 5] }, [3]),
  ]);
  assert.equal(broken.status, "incomplete");
  assert.equal(broken.totalMissed, 1);
});

test("an unreachable population is reported, never reported as empty", () => {
  const audit = auditResource(sale, []);
  assert.ok(audit.knownGaps.length > 0, "Sale's archived population cannot be enumerated");
  assert.match(audit.knownGaps[0], /archived/i);

  const item = plan.groups.find((g) => g.resource === "Item")!;
  assert.deepEqual(auditResource(item, []).knownGaps, [],
    "Item's archived filter works, so it has no known gap");
});

test("windows must tile the id range exactly", () => {
  assert.doesNotThrow(() => assertWindowsTile(shardIdRange(1, 250, 100), 1, 250));

  assert.throws(() => assertWindowsTile([{ from: 1, to: 100 }, { from: 150, to: 250 }], 1, 250),
    /would never be scanned/, "a hole is an unexamined region no later check looks at");

  assert.throws(() => assertWindowsTile([{ from: 1, to: 120 }, { from: 100, to: 250 }], 1, 250),
    /overlap/, "an overlap stages records twice");

  assert.throws(() => assertWindowsTile([{ from: 5, to: 250 }], 1, 250), /start at/);
  assert.throws(() => assertWindowsTile([{ from: 1, to: 200 }], 1, 250), /end at/);
  assert.throws(() => assertWindowsTile([], 1, 250), /would go unscanned/);
  assert.doesNotThrow(() => assertWindowsTile([], 1, 0), "an empty resource needs no windows");
});

test("orphaned foreign keys surface a missed parent population", () => {
  // Sale lines referencing items that were never staged: the classic symptom of
  // an unswept archived item set.
  assert.deepEqual(findOrphans([1, 2, 3], [1, 2]), ["3"]);
  assert.deepEqual(findOrphans([1, 2], [1, 2, 3]), [], "unused parents are fine");
  assert.deepEqual(findOrphans([0, 0], [1]), [],
    "R-Series uses 0 as an absent-reference sentinel, not a real key");
  assert.deepEqual(findOrphans([], []), []);
});

test("every scan group can be audited without special-casing", () => {
  for (const g of plan.groups) {
    const verdict = classifyWindow(g, { window: { from: 1, to: 3 }, observedIds: [1, 2, 3] }, []);
    assert.equal(verdict.status, "complete", `${g.resource} failed a trivially complete window`);
    assert.equal(verdict.resource, g.resource);
    assert.doesNotThrow(() => buildGapProbes(g, [1, 2, 3]));
  }
});
