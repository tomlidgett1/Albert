import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deputyManifest } from "../../connectors/deputy/manifest.js";
import {
  connectorHookDatabase,
  connectorHookDatabaseBinding,
} from "../../connectors/canonical-registry.js";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";

const genericRuntimeFiles = [
  "services/sync-workers/src/canonical-pipeline.ts",
  "services/sync-workers/src/canonical-contract.ts",
  "services/sync-workers/src/control-plane-store.ts",
  "services/sync-workers/src/typed-staging.ts",
  "services/sync-workers/src/vendor-rate-budget.ts",
  "services/sync-workers/src/webhook-tombstones.ts",
  "services/sync-workers/src/worker.ts",
] as const;

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("generic sync data-plane modules contain no connector business branches", () => {
  for (const relativePath of genericRuntimeFiles) {
    const lines = source(relativePath).split("\n");
    for (const [index, line] of lines.entries()) {
      if (!/(?:lightspeed(?:-r)?|xero|deputy)/iu.test(line)) continue;
      assert.fail(
        `${relativePath}:${index + 1} adds connector-specific logic outside its pack: ${line.trim()}`,
      );
    }
  }

  const canonical = source("services/sync-workers/src/canonical-pipeline.ts");
  assert.doesNotMatch(canonical, /defaultAuthority|sourceAuthorityByStream/iu);
  assert.match(canonical, /assertCanonicalCommandAuthority\(command,streamAuthority\)/u);
  assert.doesNotMatch(canonical, /lightspeed_supplier_replay|source_lightspeed\.orders/iu);
  assert.doesNotMatch(canonical, /source_xero|xero_gl_account_code|Xero Organisation/iu);
  assert.doesNotMatch(
    canonical,
    /connectorId\s*[!=]==?\s*["'](?:lightspeed-r|xero|deputy)["']/iu,
  );
});

test("replay candidates are runtime-minted opaque capabilities",async()=>{
  const client:PostgresQueryClient={
    async query<Row extends Record<string,unknown>>(){
      return{rows:[{
        tenant_id:"tenant",namespaced_source_key:"source-key",
        connection_id:"connection",external_account_reference:"account",
        source_object_type:"Order",source_record_id:"order-1",source_version:null,
        source_updated_at:"2026-08-01T00:00:00.000Z",payload_hash:"a".repeat(64),
        payload_batch_id:"legacy-batch",sync_run_id:"legacy-run",tombstone:false,
        mapping_version:"canonical-v1",predecessor_connector_version:"1.0.0",
        predecessor_api_version:lightspeedRManifest.apiVersion,
        predecessor_schema_version:"1.0.0",predecessor_stream:"orders",
      }] as unknown as Row[]};
    },
  };
  const binding=connectorHookDatabaseBinding("lightspeed-r.compatibility-replay",client,{
    tenantId:"tenant",connectionId:"connection",connectionGeneration:7,
    batchId:"current-batch",syncRunId:"current-run",mappingVersion:"canonical-v1",
  });
  const handles=await binding.database.replayCandidates(
    "compatibility.replay_candidates",
    ["tenant","connection","canonical-v1",7,100,lightspeedRManifest.apiVersion],
  );
  assert.equal(handles.length,1);
  assert.equal(Object.keys(handles[0]!).length,0);
  assert.doesNotThrow(()=>binding.assertReplaySelection(true,handles));
  assert.throws(()=>binding.assertReplaySelection(true,[]),/canonical_dependency_replay_selection_invalid/u);
  assert.throws(()=>binding.assertReplaySelection(false,handles),/canonical_dependency_replay_selection_invalid/u);
  assert.throws(
    ()=>binding.resolveReplayCandidate(Object.freeze({}) as never),
    /canonical_dependency_replay_candidate_invalid/u,
  );
  assert.equal(binding.resolveReplayCandidate(handles[0]!).source_record_id,"order-1");
  await assert.rejects(
    binding.database.run("compatibility.record_replay",[
      "tenant","connection","current-batch","current-run","source-key",
      "a".repeat(64),"canonical-v1",
    ]),
    /canonical_hook_database_operation_denied/u,
  );
  await assert.rejects(
    binding.database.run("compatibility.finalize",["tenant","connection","current-batch"]),
    /canonical_hook_database_operation_denied/u,
  );
});

test("an ineligible replay may return no candidates without opening finalization",()=>{
  const client:PostgresQueryClient={
    async query<Row extends Record<string,unknown>>(){return{rows:[] as Row[]};},
  };
  const binding=connectorHookDatabaseBinding("lightspeed-r.compatibility-replay",client,{
    tenantId:"tenant",connectionId:"connection",connectionGeneration:7,
    batchId:"current-batch",syncRunId:"current-run",mappingVersion:"canonical-v1",
  });
  assert.doesNotThrow(()=>binding.assertReplaySelection(false,[]));
  assert.throws(
    ()=>binding.assertReplaySelection(true,[]),
    /canonical_dependency_replay_selection_invalid/u,
  );
});

test("connector manifests own authority, staging, budget and webhook policy", () => {
  assert.match(
    source("services/sync-workers/src/typed-staging.ts"),
    /contract\.reprocessIdenticalPayloadOnNewBatch/u,
  );
  assert.match(
    source("services/sync-workers/src/vendor-rate-budget.ts"),
    /manifest\.rateLimit\.reservations/u,
  );
  assert.match(
    source("services/sync-workers/src/webhook-tombstones.ts"),
    /manifest\.webhook\?\.verifiedTombstones/u,
  );
  const itemShops = lightspeedRManifest.streams.find((stream) => stream.id === "item_shops");
  assert.equal(itemShops?.reprocessIdenticalPayloadOnNewBatch, true);
  assert.deepEqual(lightspeedRManifest.sourceAuthority.defaults, [{
    concepts: ["operational_sales", "stock", "product_master", "customer_master"],
    scope: { kind: "connection_account" },
  }]);

  assert.deepEqual(xeroManifest.sourceAuthority.defaults, [{
    concepts: ["statutory_finance", "cash_settlement"],
    scope: { kind: "canonical_dimension", table: "legal_entity", scopeType: "legal_entity" },
  }]);
  const daily = xeroManifest.rateLimit.reservations.find((policy) =>
    policy.interval.kind === "window_budget"
  );
  assert.deepEqual(daily, {
    key: "xero.api-day",
    burstCapacity: 60,
    interval: {
      kind: "window_budget",
      windowMilliseconds: 86_400_000,
      option: "dailyRequestLimit",
      defaultLimit: 1_000,
      allowedLimits: [1_000, 5_000],
    },
  });

  assert.deepEqual(deputyManifest.webhook?.verifiedTombstones, {
    jobReason: "webhook",
    requireReceipt: true,
    payloadSignalType: "verified_deputy_webhook_tombstone",
  });
});

test("connector-specific compatibility replay lives under its connector pack", () => {
  const generic = source("services/sync-workers/src/canonical-pipeline.ts");
  const pack = source("connectors/lightspeed-r/compatibility-replay.ts");
  const registry = source("connectors/canonical-registry.ts");
  assert.match(generic, /connectorCompatibilityReplay/iu);
  assert.match(pack, /compatibility\.replay_generation/iu);
  assert.match(pack, /database\.replayCandidates/iu);
  assert.doesNotMatch(pack, /compatibility\.record_replay|compatibility\.finalize/iu);
  assert.match(registry, /lightspeed_supplier_replay_generation/iu);
  assert.match(registry, /record_lightspeed_order_dependency_replay/iu);
  assert.match(registry, /finalize_lightspeed_supplier_replay_gate/iu);
  assert.match(generic,/binding\.finalizeReplay/u);
});

test("connector-specific canonical lookups and dossier evidence live under their pack", () => {
  const generic = source("services/sync-workers/src/canonical-pipeline.ts");
  const pack = source("connectors/xero/canonical-policy.ts");
  const registry = source("connectors/canonical-registry.ts");
  assert.match(generic, /connectorReferenceLookup/iu);
  assert.match(generic, /connectorDossierContributors/iu);
  assert.match(registry, /xeroReferenceLookup/iu);
  assert.match(registry, /xeroDossierContributor/iu);
  assert.match(pack, /reference\.natural_key_candidates/iu);
  assert.match(pack, /dossier\.latest_source/iu);
  assert.match(registry, /source_xero\.accounts/iu);
  assert.match(registry, /source_xero\.organisation/iu);
  assert.match(pack, /gl_account_code/iu);
});

test("connector hooks receive only a reviewed operation capability, never a SQL client", () => {
  const contract = source("services/sync-workers/src/canonical-contract.ts");
  const packs = [
    source("connectors/lightspeed-r/compatibility-replay.ts"),
    source("connectors/xero/canonical-policy.ts"),
  ];
  assert.match(contract, /CanonicalHookDatabase/iu);
  assert.match(contract, /database:\s*CanonicalHookDatabase/iu);
  assert.doesNotMatch(contract, /PostgresQueryClient/iu);
  for (const pack of packs) {
    assert.doesNotMatch(pack, /PostgresQueryClient|\.query\s*\(/iu);
    assert.doesNotMatch(pack, /\b(?:select|insert|update|delete)\s+(?:from|into|[a-z_])/iu);
  }
});

test("connector hook database denies unregistered, malformed and unbounded operations", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let rows: readonly Readonly<Record<string, unknown>>[] = [];
  const client: PostgresQueryClient = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<Readonly<{ rows: readonly Row[] }>> {
      calls.push({ sql, values });
      return { rows: rows as readonly Row[] };
    },
  };

  const xero = connectorHookDatabase("xero.reference-lookup", client, {
    tenantId: "tenant",
    connectionId: "connection",
    connectionGeneration:4,
  });
  await assert.rejects(
    xero.run("reference.caller_authored_sql", ["tenant"]),
    /canonical_hook_database_operation_denied/u,
  );
  await assert.rejects(
    xero.run("dossier.latest_source", ["tenant"]),
    /canonical_hook_database_operation_denied/u,
  );
  await assert.rejects(
    xero.run("reference.natural_key_candidates", ["tenant", "connection", "",4]),
    /canonical_hook_database_parameters_invalid/u,
  );
  await assert.rejects(
    xero.run("reference.natural_key_candidates", ["other-tenant", "connection", "400",4]),
    /canonical_hook_database_parameters_invalid/u,
  );
  await assert.rejects(
    xero.run("reference.natural_key_candidates", ["tenant", "other-connection", "400",4]),
    /canonical_hook_database_parameters_invalid/u,
  );
  assert.equal(calls.length, 0, "denied capabilities must never reach Postgres");

  rows = [{ source_record_id: "account-1", source_object_type: "Account" }];
  const matched = await xero.run(
    "reference.natural_key_candidates",
    ["tenant", "connection", "400",4],
  );
  assert.equal(matched.length, 1);
  assert.equal(Object.isFrozen(matched), true);
  assert.equal(Object.isFrozen(matched[0]), true);
  assert.match(calls[0]?.sql ?? "", /source_xero\.accounts/u);
  assert.deepEqual(calls[0]?.values, ["tenant", "connection", "400",4]);

  rows = [
    { source_record_id: "account-1" },
    { source_record_id: "account-2" },
    { source_record_id: "account-3" },
  ];
  await assert.rejects(
    xero.run("reference.natural_key_candidates", ["tenant", "connection", "400",4]),
    /canonical_hook_database_result_unbounded/u,
  );
  await assert.rejects(
    xero.run("reference.natural_key_candidates", ["tenant", "connection", "400",3]),
    /canonical_hook_database_parameters_invalid/u,
  );

  const lightspeed = connectorHookDatabase("lightspeed-r.compatibility-replay", client, {
    tenantId: "tenant",
    connectionId: "connection",
    batchId: "batch",
    syncRunId: "run",
    mappingVersion: "canonical-v1",
    connectionGeneration: 1,
  });
  await assert.rejects(
    lightspeed.run("compatibility.replay_candidates", [
      "tenant", "connection", "canonical-v1", 1, 101,
    ]),
    /canonical_hook_database_operation_denied/u,
  );
  await assert.rejects(
    lightspeed.replayCandidates("compatibility.replay_candidates", [
      "tenant", "connection", "canonical-v1", 1, 101,lightspeedRManifest.apiVersion,
    ]),
    /canonical_hook_database_parameters_invalid/u,
  );
  await assert.rejects(
    lightspeed.run("compatibility.replay_generation", [
      "tenant", "connection", "other-batch",1,
    ]),
    /canonical_hook_database_parameters_invalid/u,
  );

  const dossier=connectorHookDatabase("xero.dossier",client,{
    tenantId:"tenant",connectionId:"connection",connectionGeneration:4,
  });
  await assert.rejects(
    dossier.run("reference.natural_key_candidates",["tenant","connection","400"]),
    /canonical_hook_database_operation_denied/u,
  );
  await assert.rejects(
    dossier.run("dossier.latest_source",["tenant","connection",3]),
    /canonical_hook_database_parameters_invalid/u,
  );
});
