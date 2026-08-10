import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { diffSemanticRegistryV2 } from "../../packages/semantic-registry/src/v2-diff.js";
import { semanticRegistryDocumentV2Schema } from "../../packages/semantic-registry/src/v2.js";

const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);

test("semantic diffs are deterministic and empty for identical manifests", () => {
  const first = diffSemanticRegistryV2(registry, structuredClone(registry));
  const second = diffSemanticRegistryV2(registry, structuredClone(registry));
  assert.deepEqual(first, second);
  assert.deepEqual(first.changes, []);
  assert.deepEqual(first.summary, {
    added: 0,
    removed: 0,
    changed: 0,
    high: 0,
    medium: 0,
    low: 0,
    byObjectType: {},
  });
});

test("semantic diffs separate descriptive edits from executable measure changes", () => {
  const candidate = structuredClone(registry);
  const source = candidate.sourceObjects[0]!;
  source.description = `${source.description} Reviewed wording.`;
  const measure = candidate.measures.find(
    ({ expression }) => expression.op === "aggregate" && expression.fieldId,
  )!;
  measure.expression = { op: "aggregate", fn: "count_distinct" };

  const diff = diffSemanticRegistryV2(registry, candidate);
  const sourceChange = diff.changes.find(
    ({ objectId }) => objectId === source.id,
  );
  const measureChange = diff.changes.find(
    ({ objectId }) => objectId === measure.id,
  );
  assert.equal(sourceChange?.severity, "low");
  assert.deepEqual(sourceChange?.changedFields, ["description"]);
  assert.equal(sourceChange?.requiredReviewTier, "tier_3");
  assert.equal(measureChange?.severity, "high");
  assert.deepEqual(measureChange?.changedFields, ["expression"]);
  assert.equal(measureChange?.requiredReviewTier, "tier_1");
});

test("removals are high impact while new unresolved candidates require tier-two review", () => {
  const candidate = structuredClone(registry);
  const removed = candidate.dimensions.pop()!;
  const added = {
    ...candidate.relationshipCandidates[0]!,
    id: "candidate.fixture.added_relationship_candidate",
  };
  candidate.relationshipCandidates.push(added);
  const diff = diffSemanticRegistryV2(registry, candidate);
  assert.equal(
    diff.changes.find(({ objectId }) => objectId === removed.id)?.severity,
    "high",
  );
  assert.equal(
    diff.changes.find(({ objectId }) => objectId === added.id)?.severity,
    "medium",
  );
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.added, 1);
});

test("semantic diffs report optional properties added to existing objects", () => {
  const candidate = structuredClone(registry);
  const source = candidate.sourceObjects[0]!;
  source.additivityAxis = "fixture.snapshot_date";

  const diff = diffSemanticRegistryV2(registry, candidate);
  const change = diff.changes.find(({ objectId }) => objectId === source.id);
  assert.deepEqual(change?.changedFields, ["additivityAxis"]);
  assert.equal(change?.severity, "high");
  assert.equal(change?.requiredReviewTier, "tier_1");
});
