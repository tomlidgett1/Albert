import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deputyManifest } from "../../connectors/deputy/manifest.js";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";
import {
  CAPABILITY_IDS,
  SEMANTIC_CAPABILITY_IDS,
  buildStagingContracts,
  type ConnectorManifest,
  type FieldCoverage,
} from "../../packages/connector-sdk/src/index.js";
import {
  assertCapabilityContract,
  parseRegistryDocument,
} from "../../packages/semantic-registry/src/index.js";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import {
  publishSourceAllowlist,
} from "../../services/sync-workers/src/canonical-pipeline.js";
import type { CanonicalTransformBatch } from "../../services/sync-workers/src/canonical-contract.js";

const registry = parseRegistryDocument(readFileSync(
  new URL("../../packages/semantic-registry/registry/registry.yaml", import.meta.url),
  "utf8",
));
const manifests = [lightspeedRManifest,xeroManifest,deputyManifest] as const;

test("semantic consumers and connector producers share one exact capability vocabulary", () => {
  assert.doesNotThrow(() => assertCapabilityContract(registry,manifests));
  const consumed = new Set([
    ...registry.metrics.flatMap((metric) => metric.requiredCapabilities),
    ...registry.topics.flatMap((topic) => topic.requiredCapabilities),
  ]);
  assert.deepEqual([...consumed].sort(),[...SEMANTIC_CAPABILITY_IDS].sort());
  for(const topic of registry.topics){
    for(const capability of topic.requiredCapabilities){
      const producers=manifests.flatMap((manifest)=>{
        const declaration=manifest.capabilities[capability];
        return declaration?[declaration]:[];
      });
      assert.ok(producers.some((producer)=>producer.support!=="unavailable"),`${topic.id}:${capability}`);
    }
  }
});

test("the database accepts every runtime capability identifier and no stale aliases", () => {
  const vocabularyMigrations = [
    "infra/migrations/analytical/0073_m5_canonical_capability_vocabulary.sql",
    "infra/migrations/analytical/0094_m5_lightspeed_purchase_order_capability.sql",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  const persisted = [...vocabularyMigrations.matchAll(
    /\(\s*'([a-z][a-z0-9_.]*)'\s*,\s*(?:true|false)\s*,\s*'/gu,
  )].map((match) => match[1]);
  assert.deepEqual([...new Set(persisted)].sort(), [...CAPABILITY_IDS].sort());
});

test("a producer alias cannot pass the registry contract", () => {
  const { ["inventory.balances"]: removed, ...capabilities } = lightspeedRManifest.capabilities;
  assert.ok(removed);
  const aliased = {
    ...lightspeedRManifest,
    capabilities: {
      ...capabilities,
      "inventory.current_stock": removed,
    },
  } as unknown as ConnectorManifest;
  assert.throws(
    () => assertCapabilityContract(registry,[aliased,xeroManifest,deputyManifest]),
    /unknown capability identifiers/u,
  );
});

test("live capability evidence is monotonic across replicas for one pack version", () => {
  const migration = readFileSync(
    "infra/migrations/analytical/0073_m5_canonical_capability_vocabulary.sql",
    "utf8",
  );
  assert.match(
    migration,
    /tenant_capability\.pack_version=excluded\.pack_version[\s\S]*support='full' AND excluded\.support IN \('partial','unknown'\)/u,
  );
  assert.match(
    migration,
    /support='partial' AND excluded\.support='unknown'/u,
  );
  assert.doesNotMatch(
    migration,
    /excluded\.support IN \('partial','unknown','unavailable'\)/u,
    "an explicit unavailable observation must still revoke support",
  );
});

test("source allowlist publication atomically retires removed and newly sensitive fields", async () => {
  const accounts = buildStagingContracts([xeroManifest]).find((contract)=>contract.stream==="xero_accounts");
  assert.ok(accounts);
  const job = {
    tenantId:"01J00000000000000000000001",batchId:"01J00000000000000000000002",
    syncRunId:"01J00000000000000000000003",connectionId:"01J00000000000000000000004",
    connectionGeneration:1,connectorId:"xero",mappingVersion:"test",
  } as const satisfies CanonicalTransformBatch;
  const active=new Set<string>();
  const statements:string[]=[];
  const client:PostgresQueryClient={
    async query<Row extends Record<string,unknown>>(sql:string,values:readonly unknown[]=[]){
      statements.push(sql);
      if(sql.startsWith("update semantic_internal.source_field_allowlist"))active.clear();
      if(sql.startsWith("insert into semantic_internal.source_field_allowlist"))active.add(String(values[5]));
      return{rows:[] as readonly Row[]};
    },
  };

  await publishSourceAllowlist(client,job,reclassifyXeroAccountClass({
    disposition:"governed_extension",
    pii:"none",
  }),accounts);
  assert.ok(active.has("class"),"the reviewed non-PII extension should be active");
  assert.match(statements[0]??"",/set active=false/u);

  statements.length=0;
  await publishSourceAllowlist(client,job,reclassifyXeroAccountClass({
    disposition:"unsupported",
    reason:"Removed from governed exploration by the exact pack publication.",
  }),accounts);
  assert.equal(active.has("class"),false,"governed to unsupported must retire stale access");
  assert.match(statements[0]??"",/set active=false/u);

  statements.length=0;
  await publishSourceAllowlist(client,job,reclassifyXeroAccountClass({
    disposition:"governed_extension",
    pii:"customer_contact",
  }),accounts);
  assert.equal(active.has("class"),false,"governed to PII must retire stale access");
  assert.match(statements[0]??"",/set active=false/u);
});

function reclassifyXeroAccountClass(
  patch:Partial<FieldCoverage>,
):ConnectorManifest{
  return{
    ...xeroManifest,
    packVersion:"1.0.1-test",
    fieldCoverage:xeroManifest.fieldCoverage.map((entry)=>
      entry.stream==="xero_accounts"&&entry.field==="Class"?{...entry,...patch}:entry,
    ),
  } as ConnectorManifest;
}
