import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { deputyManifest } from "../../connectors/deputy/manifest.js";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";

const root = new URL("../../", import.meta.url);
const migrationUrl = new URL(
  "infra/migrations/control-plane/0091_m3_spec_driven_stream_expectations.sql",
  root,
);
/**
 * 0091 is applied and therefore immutable, so Xero pack 2.0.0 re-seeded the
 * stream inventory in its own migration. The gate's structure is still asserted
 * against 0091; only the seeded rows moved.
 */
const streamSeedUrl = new URL(
  "infra/migrations/control-plane/0095_m3_xero_pack_2_stream_expectations.sql",
  root,
);

type StreamExpectation = Readonly<{
  connectorKey: string;
  packVersion: string;
  apiVersion: string;
  stream: string;
  required: boolean;
  backfillStrategy: string;
  domains: readonly string[];
  dependencies: readonly string[];
  lateEditStrategy: string;
  deletionStrategy: string;
  sourceTotalStrategy: string;
}>;

function sqlTextArray(value: string): readonly string[] {
  return [...value.matchAll(/'([^']+)'/gu)].map((match) => match[1]!).sort();
}

function sortStreams(streams: readonly StreamExpectation[]): readonly StreamExpectation[] {
  return [...streams].sort((left, right) =>
    `${left.connectorKey}:${left.stream}`.localeCompare(`${right.connectorKey}:${right.stream}`),
  );
}

test("the protected M3 structural inventory matches manifests while M4 owns current required coverage", async () => {
  const [sql, seedSql] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(streamSeedUrl, "utf8"),
  ]);
  const insert = seedSql.match(
    /INSERT INTO control_plane\.protected_dogfood_stream_expectation\([\s\S]*?\) VALUES([\s\S]*?)ON CONFLICT/iu,
  )?.[1];
  assert.ok(insert, "protected dogfood stream expectation seed is missing");

  const seeded = [...insert.matchAll(
    /\('([^']+)','([^']+)','([^']+)','([^']+)',(true|false),'([^']+)',ARRAY\[([^\]]*)\]::text\[\],ARRAY\[([^\]]*)\]::text\[\],'([^']+)','([^']+)','([^']+)'\)/gu,
  )].map((match) => ({
    connectorKey: match[1]!,
    packVersion: match[2]!,
    apiVersion: match[3]!,
    stream: match[4]!,
    required: match[5] === "true",
    backfillStrategy: match[6]!,
    domains: sqlTextArray(match[7]!),
    dependencies: sqlTextArray(match[8]!),
    lateEditStrategy: match[9]!,
    deletionStrategy: match[10]!,
    sourceTotalStrategy: match[11]!,
  }));
  const manifests = [lightspeedRManifest, xeroManifest, deputyManifest];
  const reviewed = manifests.flatMap((manifest) => manifest.streams.map((stream) => ({
    connectorKey: manifest.id,
    packVersion: manifest.packVersion,
    apiVersion: manifest.apiVersion,
    stream: stream.id,
    required: (stream.availability ?? "required") === "required",
    backfillStrategy: stream.backfillStrategy,
    domains: [...stream.productDomains].sort(),
    dependencies: [...stream.dependencies].sort(),
    lateEditStrategy: stream.lateEditStrategy,
    deletionStrategy: stream.deletionStrategy,
    sourceTotalStrategy: stream.sourceTotalStrategy,
  })));

  const seededByStream = new Map(seeded.map((stream) => [`${stream.connectorKey}:${stream.stream}`, stream]));
  for (const stream of reviewed) {
    const historical = seededByStream.get(`${stream.connectorKey}:${stream.stream}`);
    assert.ok(historical, `${stream.connectorKey}:${stream.stream} is absent from the M3 inventory`);
  }
  assert.deepEqual(
    sortStreams(seeded),
    sortStreams(reviewed.map((stream) => ({
      ...stream,
      required: seededByStream.get(`${stream.connectorKey}:${stream.stream}`)!.required,
    }))),
  );
  // The gated inventory tracks the spec-generated manifests, so its size is
  // derived from them at runtime rather than pinned to a stale count.
  assert.equal(
    seeded.length,
    manifests.reduce((total, manifest) => total + manifest.streams.length, 0),
    "V1 must gate the complete reviewed manifest stream inventory",
  );
  assert.match(sql, /dogfood stream plan does not match the exact reviewed connector manifests/u);
  assert.match(sql, /manifest\.connector_version=expected\.pack_version/u);
  assert.match(sql, /manifest\.api_version=expected\.api_version/u);
  assert.match(sql, /phase\.domains=expected\.domains/u);
  assert.match(sql, /phase\.dependencies=expected\.dependencies/u);
  assert.match(sql, /phase\.dependency_plan_sealed/u);
  assert.match(sql, /sweep\.late_edit_strategy=expected\.late_edit_strategy/u);
  assert.match(sql, /sweep\.deletion_strategy=expected\.deletion_strategy/u);
  assert.match(sql, /sweep\.source_total_strategy=expected\.source_total_strategy/u);
  assert.match(sql, /run\.connection_id=selected\.connection_id/u);
  assert.match(sql, /run\.stream=expected\.stream/u);
});

test("the protected M4 quality set follows every final required analytical expectation", async () => {
  const [sql, analyticalFiles] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readdir(new URL("infra/migrations/analytical/", root)),
  ]);
  const qualitySeed = sql.match(
    /INSERT INTO control_plane\.protected_dogfood_quality_expectation\(check_id\) VALUES([\s\S]*?)ON CONFLICT/iu,
  )?.[1];
  assert.ok(qualitySeed, "protected dogfood quality expectation seed is missing");
  const protectedChecks = [...qualitySeed.matchAll(/\('([a-z][a-z0-9_]*)'\)/gu)]
    .map((match) => match[1]!)
    .sort();

  const analyticalSql = (await Promise.all(
    analyticalFiles
      .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(filename))
      .sort()
      .map((filename) => readFile(new URL(`infra/migrations/analytical/${filename}`, root), "utf8")),
  )).join("\n");
  const blocks = [...analyticalSql.matchAll(
    /INSERT INTO quality\.check_expectation\s*\([\s\S]*?\)\s*VALUES([\s\S]*?)ON CONFLICT/giu,
  )].map((match) => match[1]!);
  const requiredChecks = [...new Set(blocks.flatMap((block) =>
    [...block.matchAll(
      /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'(?:connector|canonical|commerce|inventory|finance|workforce|reconciliation)'[\s\S]*?,\s*true\s*,\s*true\s*\)/gu,
    )].map((match) => match[1]!),
  ))].sort();

  assert.deepEqual(protectedChecks, requiredChecks);
  assert.equal(protectedChecks.length, 28, "M4 must gate every reviewed V1 quality check");
  assert.match(sql, /stat\.invariant_status IS DISTINCT FROM required_quality/u);
  assert.doesNotMatch(
    sql,
    /stat\.invariant_status<>required_quality/u,
    "quality comparison must remain NULL-safe",
  );
  assert.match(sql, /quality_run_min IS DISTINCT FROM quality_run_max/u);
  assert.match(sql, /control_plane\.is_ulid\(item\.value\) IS DISTINCT FROM true/u);
  assert.match(sql, /quality_checked_min<p_barrier_at/u);
  assert.match(sql, /quality_checked_min<candidate_evidence_at/u);
  assert.match(sql, /latest_snapshot<candidate_evidence_at/u);
  assert.match(sql, /latest_snapshot<quality_checked_min/u);
  assert.match(sql, /declared_table_count_min IS DISTINCT FROM actual_table_count/u);
  assert.match(sql, /declared_inventory_hash_min IS DISTINCT FROM actual_inventory_hash/u);
  assert.match(sql, /snapshot_inventory_hash IS NOT NULL[\s\S]*?snapshot_inventory_hash ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(
    sql,
    /jsonb_build_array\(stat\.schema_name,stat\.table_name\)[\s\S]*?ORDER BY stat\.schema_name COLLATE "C",stat\.table_name COLLATE "C"/u,
  );
  assert.match(sql, /run\.sync_run_id=quality_run_min/u);
  assert.match(sql, /connection\.connection_generation=run\.connection_generation/u);
  assert.match(
    sql,
    /manifest\.sync_run_id=run\.sync_run_id[\s\S]*?manifest\.connector_version=expected\.pack_version/u,
  );
});

test("the public diagnostic role cannot bypass the hardened collector", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /RENAME TO capture_protected_dogfood_acceptance_v1/u);
  assert.match(
    sql,
    /capture_protected_dogfood_acceptance_v1\([\s\S]*?\)[\s\S]*?FROM PUBLIC,anon,authenticated,service_role,albert_operator_diagnostic_control/iu,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION control_plane\.capture_protected_dogfood_acceptance\([\s\S]*?\) TO albert_operator_diagnostic_control/iu,
  );
  assert.match(sql, /PERFORM control_plane\.assert_protected_dogfood_manifest_and_quality/u);
});

test("SQL CI exercises manifest semantics and candidate causality", async () => {
  const [workflow, proof] = await Promise.all([
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    readFile(
      new URL("tests/sql/control-plane-protected-dogfood-manifest-quality.sql", root),
      "utf8",
    ),
  ]);
  assert.match(workflow, /control-plane-protected-dogfood-manifest-quality\.sql/u);
  for (const phrase of [
    "wrong product domain",
    "wrong dependency DAG",
    "unreviewed API version",
    "cross-connection/cross-stream run evidence",
    "quality evidence predating final stream completion",
    "valid exact projection",
    "JSON-null connection selector",
    "duplicate projected table",
    "omitted projected table",
    "extra projected table",
    "substituted projected table",
    "future-dated projected quality evidence",
  ]) assert.ok(proof.includes(phrase), `missing behavioral proof: ${phrase}`);
});
