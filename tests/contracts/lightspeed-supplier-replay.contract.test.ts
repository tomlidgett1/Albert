import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../infra/migrations/analytical/0096_m4_lightspeed_legacy_order_dependency_replay.sql",
    import.meta.url,
  ),
  "utf8",
);
const replayVariableHardening = await readFile(
  new URL(
    "../../infra/migrations/analytical/0098_m4_lightspeed_replay_variable_disambiguation.sql",
    import.meta.url,
  ),
  "utf8",
);
const pipeline = await readFile(
  new URL("../../services/sync-workers/src/canonical-pipeline.ts", import.meta.url),
  "utf8",
);
const replay = await readFile(
  new URL("../../connectors/lightspeed-r/compatibility-replay.ts", import.meta.url),
  "utf8",
);
const composition = await readFile(
  new URL("../../connectors/canonical-registry.ts", import.meta.url),
  "utf8",
);
const processor = await readFile(
  new URL("../../services/transform-worker/src/processor.ts", import.meta.url),
  "utf8",
);
const continuation = await readFile(
  new URL("../../infra/migrations/control-plane/0064_m4_bounded_canonical_replay_continuations.sql", import.meta.url),
  "utf8",
);

function migrationFunction(name: string): string {
  const marker = `CREATE FUNCTION ${name}`;
  const start = migration.indexOf(marker);
  assert.notEqual(start, -1, `${name} is missing from the replay migration.`);
  const end = migration.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${name} has no complete function body.`);
  return migration.slice(start, end + 4);
}

test("Lightspeed supplier replay evidence is exact and generation scoped", () => {
  assert.match(
    migration,
    /PRIMARY KEY\s*\(\s*tenant_id,connection_id,connection_generation,source_order_namespaced_key,\s*source_order_payload_hash,source_order_mapping_version\s*\)/u,
  );
  assert.match(
    composition,
    /audit\.connection_generation=\$4::bigint/u,
  );
  assert.match(
    replay,
    /compatibility\.replay_candidates[\s\S]*?job\.mappingVersion, job\.connectionGeneration/u,
  );
  assert.match(
    migrationFunction("semantic_internal.finalize_lightspeed_supplier_replay_gate"),
    /audit\.connection_generation=repair_generation/u,
  );
  const recorder = migrationFunction(
    "semantic_internal.record_lightspeed_order_dependency_replay",
  );
  const signature = recorder.slice(0, recorder.indexOf(") RETURNS boolean"));
  assert.doesNotMatch(signature, /command_count|applied_count|integer/iu);
  assert.match(recorder, /count\(DISTINCT expected\.source_record_id\)/u);
  assert.match(recorder, /materialized_line_count<>expected_line_count/u);
  assert.match(
    replayVariableHardening,
    /CREATE OR REPLACE FUNCTION semantic_internal\.record_lightspeed_order_dependency_replay/u,
  );
  assert.match(
    replayVariableHardening,
    /fact\.supplier_id=resolved_supplier_id/u,
  );
  assert.doesNotMatch(
    replayVariableHardening,
    /fact\.supplier_id=supplier_id/u,
  );
  assert.match(
    replayVariableHardening,
    /GRANT EXECUTE ON FUNCTION semantic_internal\.record_lightspeed_order_dependency_replay\([\s\S]*?\) TO transform_rw/u,
  );
});

test("Every Lightspeed replay gate mutation serializes before reading state", () => {
  const expectations = [
    ["semantic_internal.sync_lightspeed_supplier_replay_gate", "SELECT max(state.connection_generation)"],
    ["semantic_internal.invalidate_lightspeed_supplier_replay_gate", "SELECT manifest.connector_version"],
    ["semantic_internal.lightspeed_supplier_replay_generation", "SELECT release.state"],
    ["semantic_internal.record_lightspeed_order_dependency_replay", "repair_generation:="],
    ["semantic_internal.finalize_lightspeed_supplier_replay_gate", "repair_generation:="],
  ] as const;
  for (const [name, firstRead] of expectations) {
    const body = migrationFunction(name);
    const lock = body.indexOf("semantic_internal.lock_lightspeed_supplier_replay(");
    const read = body.indexOf(firstRead);
    assert.ok(lock >= 0, `${name} does not acquire the connection replay lock.`);
    assert.ok(read > lock, `${name} reads replay state before acquiring its connection lock.`);
  }
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION\s+semantic_internal\.lock_lightspeed_supplier_replay\(text,text\)/u,
  );

  const healthMutation = migrationFunction(
    "semantic_internal.sync_lightspeed_supplier_replay_gate",
  );
  const releaseFence = healthMutation.indexOf("release.pack_version='1.1.0'");
  const replayLock = healthMutation.indexOf(
    "semantic_internal.lock_lightspeed_supplier_replay(",
  );
  const firstStateRead = healthMutation.indexOf(
    "SELECT max(state.connection_generation)",
  );
  assert.ok(releaseFence >= 0, "Health mutation does not fence pack activation.");
  assert.ok(
    releaseFence < replayLock && replayLock < firstStateRead,
    "Health mutation must fence activation before waiting on replay serialization and reading state.",
  );
  assert.match(
    healthMutation.slice(releaseFence, replayLock),
    /FOR SHARE/u,
    "Health mutation does not hold the candidate release row through its gate update.",
  );
  assert.match(
    healthMutation,
    /TG_OP='DELETE' AND deletion_internal\.mutation_authorized\(\)[\s\S]*?DELETE FROM semantic_internal\.lightspeed_supplier_replay_gate_index[\s\S]*?RETURN OLD/u,
    "Authorized stream-state deletion must not recreate a replay gate during purge.",
  );
});

test("Legacy dependency replay has durable bounded continuation", () => {
  assert.match(replay, /LEGACY_LIGHTSPEED_REPLAY_CANDIDATE_LIMIT = 100/u);
  assert.match(replay, /LEGACY_LIGHTSPEED_REPLAY_COMMAND_LIMIT = 500/u);
  assert.match(
    composition,
    /order by staged\.namespaced_source_key\s+limit \$5::integer/u,
  );
  assert.match(
    pipeline,
    /selection\.candidates[\s\S]*?hook\.commandLimit-commandCount/u,
  );
  assert.match(
    composition,
    /canonical_record_state/u,
  );
  assert.match(
    pipeline,
    /const missing=upserts\.filter[\s\S]*?missing\.slice\(0,hook\.commandLimit-commandCount\)/u,
  );
  assert.match(
    processor,
    /compatibilityReplayPending[\s\S]*?queue\.continueReplay/u,
  );
  assert.match(continuation,/attempt_count=greatest\(job\.attempt_count-1,0\)/u);
  assert.match(continuation,/progressToken[\s\S]*?IS DISTINCT FROM/u);
  assert.match(composition, /finalize_lightspeed_supplier_replay_gate/u);
});
