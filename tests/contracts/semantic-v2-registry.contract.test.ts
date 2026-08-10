import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  createSemanticPublicationV2,
  MAX_MEASURE_EXPRESSION_DEPTH_V2,
  MAX_MEASURE_EXPRESSION_NODES_V2,
  measureExpressionComplexityV2,
  semanticRegistryDocumentV2Schema,
  validateSemanticRegistryV2,
} from "../../packages/semantic-registry/src/v2.js";
import { auditSemanticV2Schema } from "../../scripts/lib/semantic-v2-schema-audit.js";

const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);
const publication = JSON.parse(
  readFileSync(
    "packages/semantic-registry/registry/publication.v2.json",
    "utf8",
  ),
);
const profiler = readFileSync(
  "scripts/profile-semantic-v2-inventory.mts",
  "utf8",
);

test("V2 inventory covers every locked Lightspeed and Xero source field and excludes Deputy", () => {
  const byConnector = Object.groupBy(
    registry.sourceObjects,
    ({ connector }) => connector,
  );
  assert.equal(byConnector.lightspeed?.length, 90);
  assert.equal(
    byConnector.lightspeed?.reduce(
      (total, source) => total + source.fields.length,
      0,
    ),
    949,
  );
  assert.equal(byConnector.xero?.length, 197);
  assert.equal(
    byConnector.xero?.reduce(
      (total, source) => total + source.fields.length,
      0,
    ),
    2_079,
  );
  assert.equal(registry.sourceObjects.length, 287);
  assert.equal(
    registry.sourceObjects.reduce(
      (total, source) => total + source.fields.length,
      0,
    ),
    3_028,
  );
  assert.ok(
    registry.sourceObjects.every(
      ({ connector }) => connector === "lightspeed" || connector === "xero",
    ),
  );
  assert.ok(
    registry.sourceObjects.every(({ mappingVersion }) => mappingVersion === "2.0.0"),
    "every source object must pin the active connector pack mapping version",
  );
});

test("V2 inventory is an exact field-for-field projection of both connector catalogues", () => {
  for (const [connector, path] of [
    ["lightspeed", "connectors/lightspeed-r/tables.json"],
    ["xero", "connectors/xero/tables.json"],
  ] as const) {
    const catalogue = JSON.parse(readFileSync(path, "utf8")) as {
      tables: Array<{ id: string; columns: Array<{ name: string }> }>;
    };
    for (const table of catalogue.tables) {
      const source = registry.sourceObjects.find(
        ({ id }) => id === `${connector}.${table.id}`,
      );
      assert.ok(source, `${connector}.${table.id} is missing`);
      assert.deepEqual(
        source.fields.map(({ name }) => name),
        table.columns.map(({ name }) => name),
        `${source.id} does not exactly match its connector catalogue`,
      );
    }
  }
});

test("every source field has an explicit and internally consistent disposition", () => {
  for (const source of registry.sourceObjects) {
    assert.ok(
      source.primaryKey.length > 0,
      `${source.id} has no declared source key`,
    );
    for (const field of source.fields) {
      assert.ok(field.disposition, `${field.id} has no disposition`);
      assert.ok(field.description.trim(), `${field.id} has no description`);
      if (field.disposition === "unsupported")
        assert.ok(
          field.unsupportedReason,
          `${field.id} lacks an unsupported reason`,
        );
      if (field.pii)
        assert.notEqual(
          field.disposition,
          "measure_input",
          `${field.id} exposes PII as a measure input`,
        );
    }
  }
});

test("every queryable source field resolves exactly to the typed staging contract", () => {
  const audit = auditSemanticV2Schema({
    registry,
    migrationsDirectory: resolve("infra/migrations/analytical"),
  });
  assert.deepEqual(audit.issues, []);
  assert.equal(audit.status, "passed");
  assert.equal(audit.sourceObjectCount, 287);
  assert.equal(audit.fieldCount, 3_028);
  assert.equal(audit.semanticViewCount, 298);
  assert.ok(audit.semanticViewFieldCount > 3_000);
  assert.equal(audit.materializedFieldCount, 2_989);
  assert.equal(audit.unsupportedFieldCount, 17);
  assert.equal(audit.aliasedFieldCount, 158);

  const viewBySource = new Map(
    registry.views
      .filter(({ sourceObjectId }) => sourceObjectId)
      .map((view) => [view.sourceObjectId!, view]),
  );
  for (const source of registry.sourceObjects) {
    const view = viewBySource.get(source.id);
    assert.ok(view, `${source.id} has no generated source view`);
    const physicalFieldIds = new Set(view.physicalFields.map(({ id }) => id));
    for (const field of source.fields) {
      assert.equal(
        physicalFieldIds.has(field.id),
        !["unsupported", "deprecated"].includes(field.disposition),
        `${field.id} has incorrect physical exposure`,
      );
    }
  }
  const truncated = registry.sourceObjects
    .find(({ id }) => id === "xero.xero_payroll_nz_employee_tax")!
    .fields.find(
      ({ name }) =>
        name ===
        "kiwi_saver_employer_salary_sacrifice_contribution_rate_percentage",
    )!;
  assert.equal(truncated.name.length, 65);
  assert.equal(truncated.physicalName.length, 63);
  assert.notEqual(truncated.disposition, "unsupported");
});

test("the physical-schema audit includes canonical and mart semantic views", () => {
  const missingMart = structuredClone(registry);
  const salesView = missingMart.views.find(
    ({ id }) => id === "commerce_sales_event",
  )!;
  salesView.physicalTable = "mart.not_a_real_semantic_view";
  const audit = auditSemanticV2Schema({
    registry: missingMart,
    migrationsDirectory: resolve("infra/migrations/analytical"),
  });
  assert.ok(
    audit.issues.some(
      ({ code, objectId }) =>
        code === "MISSING_MIGRATION_VIEW" &&
        objectId === "commerce_sales_event",
    ),
  );
});

test("every source measure input is queryable through an explicitly exploratory governed measure", () => {
  const measureById = new Map(
    registry.measures.map((measure) => [measure.id, measure]),
  );
  const viewBySource = new Map(
    registry.views
      .filter(({ id }) => id.startsWith("source."))
      .map((view) => [view.sourceObjectId, view]),
  );
  let inputCount = 0;

  for (const source of registry.sourceObjects) {
    const view = viewBySource.get(source.id);
    assert.ok(view, `${source.id} has no source view`);
    assert.equal(
      view.connectionField,
      "connection_id",
      `${source.id} is not connection scoped`,
    );
    assert.equal(
      view.mappingVersion,
      source.mappingVersion,
      `${source.id} does not pin its source mapping version`,
    );
    assert.deepEqual(
      view.activeRecordFilter,
      { field: "tombstone", value: false },
      `${source.id} does not exclude deleted source records`,
    );
    for (const field of source.fields.filter(
      ({ disposition }) => disposition === "measure_input",
    )) {
      inputCount += 1;
      const measureId: string = `${view.id}.${field.name}`;
      const measure = measureById.get(measureId);
      assert.ok(measure, `${field.id} has no governed source measure`);
      assert.ok(
        view.measureIds.includes(measureId),
        `${measureId} is not exposed by ${view.id}`,
      );
      assert.equal(
        measure.semanticState,
        "exploratory",
        `${measureId} must not be generated as certified`,
      );
      assert.equal(
        measure.expression.op,
        "aggregate",
        `${measureId} must use the bounded calculation AST`,
      );
      assert.equal(
        measure.expression.fieldId,
        field.id,
        `${measureId} points to the wrong source field`,
      );
      if (source.additivity === "semi_additive") {
        assert.equal(
          measure.additivity,
          "semi_additive",
          `${measureId} lacks semi-additive semantics`,
        );
        if (view.temporalAvailability === "snapshot") {
          assert.ok(
            view.snapshotPolicy,
            `${source.id} lacks a snapshot policy`,
          );
          assert.equal(
            measure.aggregation,
            "last_value",
            `${measureId} may not be summed across snapshots`,
          );
        } else {
          assert.equal(
            view.temporalAvailability,
            "current_only",
            `${source.id} must be explicitly current-only when no snapshot history exists`,
          );
          assert.equal(
            view.snapshotPolicy,
            undefined,
            `${source.id} claims a snapshot policy without a historical snapshot key`,
          );
        }
      }
    }
  }

  assert.ok(
    inputCount > 0,
    "the generated inventory contains no source measure inputs",
  );
});

test("source views without a governed time role are explicitly current-only", () => {
  for (const view of registry.views.filter(({ sourceObjectId }) => sourceObjectId)) {
    if (view.timeRoleIds.length === 0)
      assert.equal(
        view.temporalAvailability,
        "current_only",
        `${view.id} has no time role but requires an impossible historical range`,
      );
  }
});

test("V2 publication is valid, content addressed, and reproducible", () => {
  assert.deepEqual(validateSemanticRegistryV2(registry), []);
  const rebuilt = createSemanticPublicationV2(registry);
  assert.equal(rebuilt.publicationHash, publication.publicationHash);
  assert.deepEqual(rebuilt.objectCounts, publication.objectCounts);
  assert.equal(rebuilt.objectCounts.sourceObjects, 287);
  assert.equal(rebuilt.objectCounts.fields, 3_028);
});

test("live-profiled structure and reviewed relationships carry explicit Verified evidence", () => {
  assert.equal(registry.relationships.length, 68);
  assert.ok(
    registry.relationships.every(
      ({ semanticState, evidence }) =>
        semanticState === "verified" &&
        evidence.some((entry) => entry.startsWith("profile_receipt:")) &&
        evidence.some((entry) => entry.startsWith("operator_review:")),
    ),
  );
  assert.ok(
    registry.sourceObjects.every(({ semanticState }) => semanticState === "verified"),
  );
  const sourceViews = registry.views.filter(({ sourceObjectId }) => sourceObjectId);
  assert.equal(sourceViews.length, 287);
  for (const view of sourceViews) {
    assert.equal(view.semanticState, "verified", `${view.id} is not certified`);
    const rowCount = registry.measures.find(
      ({ id }) => id === `${view.id}.row_count`,
    );
    assert.equal(
      rowCount?.semanticState,
      "verified",
      `${view.id} lacks a certified structural row count`,
    );
  }
  for (const source of registry.sourceObjects)
    for (const field of source.fields.filter(({ disposition }) =>
      ["key", "time_role", "status_filter"].includes(disposition),
    ))
      assert.equal(
        field.semanticState,
        "verified",
        `${field.id} lacks structural certification`,
      );
  for (const measureId of [
    "commerce.net_sales_ex_gst",
    "commerce.gross_margin",
    "commerce.transactions",
  ])
    assert.equal(
      registry.measures.find(({ id }) => id === measureId)?.semanticState,
      "verified",
      `${measureId} did not inherit its certified canonical fact tier`,
    );
});

test("the calculation AST is hard-bounded before compiler recursion", () => {
  for (const measure of registry.measures) {
    const complexity = measureExpressionComplexityV2(measure.expression);
    assert.ok(
      complexity.nodes <= MAX_MEASURE_EXPRESSION_NODES_V2,
      `${measure.id} exceeds the expression node limit`,
    );
    assert.ok(
      complexity.depth <= MAX_MEASURE_EXPRESSION_DEPTH_V2,
      `${measure.id} exceeds the expression depth limit`,
    );
  }
  let expression: unknown = { op: "literal", value: "0" };
  for (let depth = 0; depth < MAX_MEASURE_EXPRESSION_DEPTH_V2; depth += 1)
    expression = {
      op: "binary",
      fn: "add",
      left: expression,
      right: { op: "literal", value: "0" },
    };
  const complexity = measureExpressionComplexityV2(expression);
  assert.ok(complexity.depth > MAX_MEASURE_EXPRESSION_DEPTH_V2);
  const invalid = structuredClone(registry);
  invalid.measures[0]!.expression = expression as never;
  assert.ok(
    validateSemanticRegistryV2(invalid).some(
      ({ code, objectId }) =>
        code === "MEASURE_EXPRESSION_COMPLEXITY_EXCEEDED" &&
        objectId === invalid.measures[0]!.id,
    ),
  );
});

test("relationship candidates identify exact target keys, including role-prefixed and self-parent joins", () => {
  const sourceByView = new Map(
    registry.views.flatMap((view) =>
      view.sourceObjectId
        ? [
            [
              view.id,
              registry.sourceObjects.find(
                ({ id }) => id === view.sourceObjectId,
              )!,
            ] as const,
          ]
        : [],
    ),
  );
  for (const candidate of registry.relationshipCandidates) {
    assert.deepEqual(
      candidate.candidateViewIds,
      [...new Set(candidate.targets.map(({ viewId }) => viewId))],
      `${candidate.id} has target views without exact target keys`,
    );
    assert.ok(
      candidate.targets.every(
        ({ fieldId, matchKind }) =>
          matchKind !== "role_prefixed_key" || !fieldId.endsWith(".id"),
      ),
      `${candidate.id} inferred an entity relationship from a generic id key`,
    );
    const source = sourceByView.get(candidate.fromViewId)!;
    const sourceField = source.fields.find(
      ({ id }) => id === candidate.fromFieldId,
    )!;
    for (const target of candidate.targets) {
      const targetSource = sourceByView.get(target.viewId)!;
      const targetField = targetSource.fields.find(
        ({ id }) => id === target.fieldId,
      )!;
      assert.equal(
        sourceField.dataType,
        targetField.dataType,
        `${candidate.id} compares unlike physical key types`,
      );
    }
  }
  const rolePrefixed = registry.relationshipCandidates.find(
    ({ id }) => id === "candidate.lightspeed.ls_transfers.from_shop_id",
  );
  assert.ok(rolePrefixed);
  assert.ok(
    rolePrefixed.targets.some(
      ({ viewId, fieldId, matchKind }) =>
        viewId === "source.lightspeed.ls_shops" &&
        fieldId === "lightspeed.ls_shops.shop_id" &&
        matchKind === "role_prefixed_key",
    ),
  );
  const supplierSku = registry.relationshipCandidates.find(
    ({ id }) =>
      id === "candidate.lightspeed.ls_order_shipment_items.item_vendor_id",
  );
  assert.ok(supplierSku);
  assert.deepEqual(
    supplierSku.targets,
    [],
    "The text supplier SKU must not target the numeric vendor primary key",
  );
  const selfParent = registry.relationshipCandidates.find(
    ({ id }) => id === "candidate.lightspeed.ls_categories.parent_id",
  );
  assert.ok(selfParent);
  assert.ok(
    selfParent.targets.some(
      ({ viewId, fieldId, matchKind }) =>
        viewId === "source.lightspeed.ls_categories" &&
        fieldId === "lightspeed.ls_categories.category_id" &&
        matchKind === "self_parent_key",
    ),
  );
  assert.match(profiler, /candidateTarget\.fieldId/u);
  assert.match(profiler, /targetFieldId: targetField\.id/u);
});

test("relationship rejection requires review evidence and cannot coexist with a promoted join", () => {
  const rejectedWithoutReview = structuredClone(registry);
  const candidate = rejectedWithoutReview.relationshipCandidates.find(
    ({ disposition, targets }) =>
      disposition === "rejected" && targets.length > 0,
  )!;
  candidate.disposition = "rejected";
  candidate.reason =
    "Domain review determined that the candidate is not a reusable analytical relationship.";
  candidate.evidence = candidate.evidence.filter(
    (entry) =>
      !entry.startsWith("operator_review:") &&
      !entry.startsWith("profile_receipt:"),
  );
  let codes = new Set(
    validateSemanticRegistryV2(rejectedWithoutReview).map(({ code }) => code),
  );
  assert.ok(codes.has("MISSING_RELATIONSHIP_REJECTION_REVIEW"));

  candidate.evidence.push(`operator_review:${"a".repeat(64)}`);
  codes = new Set(
    validateSemanticRegistryV2(rejectedWithoutReview).map(({ code }) => code),
  );
  assert.equal(codes.has("MISSING_RELATIONSHIP_REJECTION_REVIEW"), false);

  const target = candidate.targets[0]!;
  rejectedWithoutReview.relationships.push({
    id: "relationship.rejected_fixture",
    fromViewId: candidate.fromViewId,
    toViewId: target.viewId,
    fromFieldId: candidate.fromFieldId,
    toFieldId: target.fieldId,
    cardinality: "many_to_one",
    optional: true,
    supportedDirections: ["from_to"],
    temporalBehavior: "not_applicable",
    semanticState: "exploratory",
    evidence: [`profile_receipt:${"b".repeat(64)}`],
  });
  codes = new Set(
    validateSemanticRegistryV2(rejectedWithoutReview).map(({ code }) => code),
  );
  assert.ok(codes.has("REJECTED_RELATIONSHIP_CANDIDATE_IS_PROMOTED"));
});

test("publication validation rejects malformed expression, membership, dependency, and relationship contracts", () => {
  const malformed = structuredClone(registry);
  const measure = malformed.measures.find(
    ({ id }) => id === "commerce.net_sales_ex_gst",
  )!;
  measure.expression = {
    op: "aggregate",
    fn: "sum",
    fieldId: "not_a_real_field",
  };
  const topic = malformed.topics.find(
    ({ id }) => id === "business.sales_performance",
  )!;
  topic.viewIds = topic.viewIds.filter((id) => id !== measure.viewId);
  malformed.relationships.push({
    id: "broken.relationship",
    fromViewId: "commerce_sales_event",
    toViewId: "inventory_health_day",
    fromFieldId: "missing_from",
    toFieldId: "missing_to",
    cardinality: "many_to_one",
    optional: true,
    supportedDirections: ["from_to"],
    temporalBehavior: "not_applicable",
    semanticState: "derived",
    evidence: ["Deliberately invalid fixture."],
  });
  const codes = new Set(
    validateSemanticRegistryV2(malformed).map(({ code }) => code),
  );
  assert.ok(codes.has("UNKNOWN_MEASURE_FIELD"));
  assert.ok(codes.has("UNEXPOSED_TOPIC_MEASURE_VIEW"));
  assert.ok(codes.has("UNKNOWN_RELATIONSHIP_FIELD"));
  assert.throws(
    () => createSemanticPublicationV2(malformed),
    /Semantic registry V2 is invalid/u,
  );
});

test("publication validation rejects a Topic with more than one semantic join path", () => {
  const cyclic = structuredClone(registry);
  const topic = cyclic.topics.find(
    ({ layer, viewIds }) => layer === "source_domain" && viewIds.length >= 3,
  )!;
  const [first, second, third] = topic.viewIds.slice(0, 3).map((viewId) =>
    cyclic.views.find(({ id }) => id === viewId)!,
  );
  const edges = [
    [first, second],
    [second, third],
    [third, first],
  ] as const;
  for (const [index, [from, to]] of edges.entries()) {
    const id = `relationship.cycle_fixture_${index}`;
    cyclic.relationships.push({
      id,
      fromViewId: from.id,
      toViewId: to.id,
      fromFieldId: from.physicalFields[0]!.id,
      toFieldId: to.physicalFields[0]!.id,
      cardinality: "many_to_one",
      optional: true,
      supportedDirections: ["from_to"],
      temporalBehavior: "not_applicable",
      semanticState: "exploratory",
      evidence: [`profile_receipt:${"c".repeat(64)}`],
    });
    topic.relationshipIds.push(id);
  }
  assert.ok(
    validateSemanticRegistryV2(cyclic).some(
      ({ code, objectId }) =>
        code === "AMBIGUOUS_TOPIC_JOIN_PATH" && objectId === topic.id,
    ),
  );
});

test("Topics are layered, permission-neutral, and explicit about unresolved source joins", () => {
  const layers = Object.groupBy(registry.topics, ({ layer }) => layer);
  assert.ok((layers.source_domain?.length ?? 0) > 0);
  assert.ok((layers.business?.length ?? 0) > 0);
  assert.ok((layers.composite?.length ?? 0) >= 5);
  assert.ok(
    registry.topics.every(
      (topic) => !/(role|permission|owner|manager|bookkeeper)/iu.test(topic.id),
    ),
  );
  assert.ok(registry.relationshipCandidates.length > 0);
  assert.ok(
    registry.relationshipCandidates.every(
      ({ disposition, reason }) =>
        disposition !== "unresolved" || reason.length > 0,
    ),
  );
  for (const topic of registry.topics.filter(
    ({ layer }) => layer === "source_domain",
  )) {
    for (const viewId of topic.viewIds) {
      const view = registry.views.find(({ id }) => id === viewId);
      assert.ok(view, `${topic.id} references unknown view ${viewId}`);
      for (const measureId of view.measureIds)
        assert.ok(
          topic.measureIds.includes(measureId),
          `${topic.id} omits ${measureId}`,
        );
    }
  }
  assert.ok(
    registry.topics
      .filter(({ layer }) => layer === "composite")
      .every(
        ({ viewIds, alignOnDimensionIds }) =>
          viewIds.length >= 2 &&
          new Set(
            alignOnDimensionIds.map(
              (id) =>
                registry.dimensions.find((dimension) => dimension.id === id)
                  ?.viewId,
            ),
          ).size >= 2,
      ),
  );
});

test("live source and relationship profiling is explicit, read-only, tenant and connection scoped, and exports no raw values", () => {
  assert.match(profiler, /--execute/u);
  assert.match(
    profiler,
    /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u,
  );
  assert.match(profiler, /set_config\('albert\.tenant_id'/u);
  assert.match(profiler, /t\.connection_id=f\.connection_id/u);
  assert.match(profiler, /mapping_version/u);
  assert.match(profiler, /fromSource\.mappingVersion/u);
  assert.match(profiler, /targetSource\.mappingVersion/u);
  assert.match(profiler, /No raw sample values are exported/u);
  assert.match(
    profiler,
    /field\.pii \|\|\s*field\.disposition === "sensitive_metadata"\s*\? "redacted"\s*: "not_exported"/u,
  );
  assert.doesNotMatch(profiler, /SELECT \*/u);
});
