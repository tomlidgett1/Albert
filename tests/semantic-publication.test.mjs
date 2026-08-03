import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deputyManifest } from "../connectors/deputy/manifest.ts";
import { lightspeedRManifest } from "../connectors/lightspeed-r/manifest.ts";
import { xeroManifest } from "../connectors/xero/manifest.ts";
import { buildGovernedSourceCatalogueFields } from "../packages/connector-sdk/src/index.ts";
import {
  combineCatalogueDocuments,
  createRegistryCatalogueDocuments,
  createSourceFieldCatalogueDocuments,
  createSemanticPublicationPlan,
  parseRegistryDocument,
} from "../packages/semantic-registry/src/index.ts";

const registry = parseRegistryDocument(
  readFileSync("packages/semantic-registry/registry/registry.yaml", "utf8"),
);

test("semantic publication is deterministic and carries generated counts", () => {
  const left = createSemanticPublicationPlan(registry, {
    xero: "1.0.0",
    deputy: "1.0.0",
    "lightspeed-r": "1.0.0",
  });
  const right = createSemanticPublicationPlan(registry, {
    deputy: "1.0.0",
    "lightspeed-r": "1.0.0",
    xero: "1.0.0",
  });

  assert.deepEqual(left, right);
  assert.equal(left.contractCount, registry.metrics.length);
  assert.equal(left.topicCount, registry.topics.length);
  assert.match(left.registryHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(left.manifest.metricIds, [...left.manifest.metricIds].sort());
  assert.equal(left.manifest.registryHash, left.registryHash);
});

test("semantic publication rejects malformed connector versions", () => {
  assert.throws(
    () => createSemanticPublicationPlan(registry, { xero: "latest" }),
    /Invalid connector pack publication entry/,
  );
});

test("registry catalogue documents are deterministic, complete and content-addressed", () => {
  const left = createRegistryCatalogueDocuments(registry);
  const right = createRegistryCatalogueDocuments(registry);
  assert.deepEqual(left, right);
  const dimensions = new Set(registry.topics.flatMap((topic) => topic.approvedDimensions));
  assert.equal(left.length, registry.metrics.length + registry.topics.length + dimensions.size);
  assert.equal(new Set(left.map(({ id }) => id)).size, left.length);
  assert.deepEqual(left.map(({ id }) => id), left.map(({ id }) => id).sort());
  for (const document of left) {
    assert.match(document.id, /^(metric|topic|field):[a-z0-9_.]+$/);
    assert.match(document.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(document.content.length > document.title.length);
    assert.doesNotMatch(JSON.stringify(document), /(api[_-]?key|client[_-]?secret|access[_-]?token)/i);
  }
  for (const metric of registry.metrics) {
    const document = left.find(({ id }) => id === `metric:${metric.id}`);
    assert.ok(document);
    for (const synonym of metric.synonyms) assert.match(document.content.toLowerCase(),new RegExp(synonym.toLowerCase().replaceAll(/[^a-z0-9]+/g,".*")));
  }
  for (const dimension of dimensions) assert.ok(left.some(({ id }) => id === `field:${dimension}`));
});

test("governed connector fields form a complete, PII-labelled immutable catalogue slice", () => {
  const manifests = [deputyManifest,lightspeedRManifest,xeroManifest];
  const sourceFields = buildGovernedSourceCatalogueFields(manifests);
  const documents = createSourceFieldCatalogueDocuments(sourceFields);
  assert.equal(documents.length, manifests.flatMap(({ fieldCoverage }) => fieldCoverage).filter(({ disposition }) => disposition === "governed_extension").length);
  assert.equal(new Set(documents.map(({ id }) => id)).size,documents.length);
  for (const document of documents) {
    assert.match(document.id,/^source_field:[a-z0-9-]+:[a-z_][a-z0-9_]*:[a-z_][a-z0-9_]*$/);
    assert.equal(document.kind,"source_field");
    assert.ok(typeof document.metadata.pii === "string");
    assert.ok(typeof document.metadata.queryable === "boolean");
  }
  const alias = documents.find(({ id }) => id === "source_field:lightspeed-r:item_shops:on_work_order");
  assert.ok(alias);
  assert.match(alias.content,/onWorkorder/);
  const all = combineCatalogueDocuments(createRegistryCatalogueDocuments(registry),documents);
  assert.equal(all.length,createRegistryCatalogueDocuments(registry).length+documents.length);
});
