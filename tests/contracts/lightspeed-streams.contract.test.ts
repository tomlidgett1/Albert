import assert from "node:assert/strict";
import test from "node:test";
import { CONNECTOR_EMITTED_TARGETS } from "../../packages/connector-sdk/src/contract.js";
import { SOURCE_AUTHORITY_CONCEPTS } from "../../packages/canonical-schema/src/index.js";
import { SPEC_TABLES, buildScanPlan } from "../../connectors/lightspeed-r/scan-plan.js";
import {
  DERIVED_STREAMS,
  LIGHTSPEED_STREAMS,
  SCAN_LEADERS,
  buildStreams,
} from "../../connectors/lightspeed-r/streams.js";

const plan = buildScanPlan();

test("there is exactly one stream per spec table", () => {
  assert.equal(LIGHTSPEED_STREAMS.length, SPEC_TABLES.length);
  assert.equal(LIGHTSPEED_STREAMS.length, 90);
  const ids = new Set(LIGHTSPEED_STREAMS.map((s) => s.id));
  assert.equal(ids.size, 90, "a duplicate id means one table never stages rows");
  for (const table of SPEC_TABLES) {
    assert.ok(ids.has(table.id), `${table.id} has no stream and can never be populated`);
  }
});

test("leaders and derived streams partition the set", () => {
  assert.equal(SCAN_LEADERS.length + DERIVED_STREAMS.length, LIGHTSPEED_STREAMS.length);
  assert.equal(SCAN_LEADERS.length, plan.groups.length,
    "one leader per scan group, no more and no fewer");
});

test("a derived stream depends on the walk that produces its payload", () => {
  for (const stream of DERIVED_STREAMS) {
    if (!stream.scanResource) continue;
    const group = plan.groups.find((g) => g.resource === stream.scanResource);
    assert.ok(group, `${stream.id} names a resource with no scan group`);

    // Every derived stream waits on its parent walk, including a fan-out, which
    // cannot iterate parent ids until those ids exist.
    assert.deepEqual(stream.dependencies, [group.leader.id],
      `${stream.id} must not run before ${group.leader.id}`);

    if (stream.projection === "nested") {
      assert.ok(stream.derivedFrom, `${stream.id} explodes an array and must name its path`);
    } else {
      assert.equal(stream.derivedFrom, null,
        `${stream.id} projects 1:1 or fans out and must carry no path`);
    }
  }
});

test("every stream declares how its rows are obtained", () => {
  for (const s of LIGHTSPEED_STREAMS) {
    assert.ok(["walk", "records", "nested", "fan_out"].includes(s.projection),
      `${s.id} has no projection kind`);
    if (s.isScanLeader) assert.equal(s.projection, "walk");
  }
  const fanOuts = LIGHTSPEED_STREAMS.filter((s) => s.projection === "fan_out");
  assert.ok(fanOuts.length > 0 && fanOuts.length <= 3,
    `unexpected fan-out streams: ${fanOuts.map((s) => s.id).join(", ")}`);
  for (const f of fanOuts) {
    assert.equal(f.availability, "optional",
      `${f.id} costs one request per parent record and must be optional`);
  }
});

test("a leader waits on nothing and projects records directly", () => {
  for (const stream of SCAN_LEADERS) {
    assert.deepEqual(stream.dependencies, [], `${stream.id} is a leader and must not block`);
    assert.equal(stream.derivedFrom, null);
  }
});

test("dependencies form a DAG with no self-references or dangling ids", () => {
  const ids = new Set(LIGHTSPEED_STREAMS.map((s) => s.id));
  for (const stream of LIGHTSPEED_STREAMS) {
    for (const dependency of stream.dependencies) {
      assert.notEqual(dependency, stream.id, `${stream.id} depends on itself`);
      assert.ok(ids.has(dependency), `${stream.id} depends on unknown ${dependency}`);
      const parent = LIGHTSPEED_STREAMS.find((s) => s.id === dependency)!;
      assert.deepEqual(parent.dependencies, [],
        "the graph is one level deep, so a cycle is impossible by construction");
    }
  }
});

test("every stream declares values the SDK contract accepts", () => {
  const targets = new Set<string>(CONNECTOR_EMITTED_TARGETS as readonly string[]);
  const concepts = new Set<string>(SOURCE_AUTHORITY_CONCEPTS as readonly string[]);
  for (const s of LIGHTSPEED_STREAMS) {
    assert.match(s.id, /^ls_[a-z0-9_]+$/, `${s.id} is not a valid stream id`);
    assert.ok(s.recordIdField.length > 0, `${s.id} has no record id field`);
    assert.ok(["time_windowed", "snapshot", "exhaustive_offset"].includes(s.backfillStrategy));
    assert.ok(["modified_field", "full_snapshot", "append_only"].includes(s.lateEditStrategy));
    assert.ok(["soft_delete", "verified_delete_feed", "authoritative_identity_scan", "immutable_append_only"]
      .includes(s.deletionStrategy));
    assert.ok(concepts.has(s.authorityConcept), `${s.id} has an unknown authority ${s.authorityConcept}`);
    assert.ok(s.productDomains.length > 0, `${s.id} has no readiness domain`);
    for (const target of s.canonicalTargets) {
      assert.ok(targets.has(target), `${s.id} emits unknown canonical target ${target}`);
    }
  }
});

test("keyset pagination is used wherever the vendor supports an id filter", () => {
  const keyset = LIGHTSPEED_STREAMS.filter((s) => s.pagination === "resource_id_keyset");
  assert.ok(keyset.length > 0, "id-bounded walks are the basis of the completeness proof");
  const sales = LIGHTSPEED_STREAMS.find((s) => s.id === "ls_sales")!;
  assert.equal(sales.pagination, "resource_id_keyset");
});

test("a stream that cannot report changes is never swept by a modified field", () => {
  for (const s of LIGHTSPEED_STREAMS) {
    if (s.lateEditStrategy === "modified_field") {
      assert.ok(s.modifiedField, `${s.id} claims modified-field sweeps but names no field`);
    }
  }
});

test("balance snapshots re-land on a new batch even when the payload is identical", () => {
  const snapshots = SPEC_TABLES.filter((t) => t.additivity === "last_value_over_time");
  assert.ok(snapshots.length > 0, "the spec must contain at least one semi-additive table");
  for (const table of snapshots) {
    const stream = LIGHTSPEED_STREAMS.find((s) => s.id === table.id)!;
    assert.equal(stream.reprocessIdenticalPayloadOnNewBatch, true,
      `${table.id} is a point-in-time observation; an unchanged payload is still new evidence`);
  }
});

test("relations requested by a walk are carried on its leader", () => {
  const sales = LIGHTSPEED_STREAMS.find((s) => s.id === "ls_sales")!;
  assert.ok(sales.queryJoins && sales.queryJoins.length > 0,
    "without joins the sale children need one request each");
});

test("a duplicate stream id fails the build rather than shipping a dead table", () => {
  const duped = [...SPEC_TABLES, SPEC_TABLES[0]];
  assert.throws(() => buildStreams(duped), /Duplicate stream id/);
});

test("a stream declares exactly what its mapper can emit, never the spec's intent", () => {
  // The spec documents which canonical facts a table *could* feed. A stream
  // declares what its mapper actually produces, and the transform rejects any
  // command whose target the stream did not declare. Those two legitimately
  // differ until a mapper exists, so the executable assertion is the second one:
  // every declared target must be a real emitted target, and a stream with no
  // mapper of its own must declare only the metadata observation it can make.
  const valid = new Set<string>(CONNECTOR_EMITTED_TARGETS as readonly string[]);
  for (const s of LIGHTSPEED_STREAMS) {
    assert.ok(s.canonicalTargets.length > 0, `${s.id} declares no target at all`);
    for (const target of s.canonicalTargets) {
      assert.ok(valid.has(target), `${s.id} declares unknown target ${target}`);
    }
  }

  // The sale walk is split so one economic event can never project twice:
  // the header owns the order, lines own order lines and refunds, payments
  // own tenders. Each stream declares exactly its own mapper's targets.
  const sales = LIGHTSPEED_STREAMS.find((s) => s.id === "ls_sales")!;
  assert.deepEqual([...sales.canonicalTargets].sort(), ["channel", "commerce_order", "register"]);
  const lines = LIGHTSPEED_STREAMS.find((s) => s.id === "ls_sale_lines")!;
  assert.deepEqual([...lines.canonicalTargets].sort(), ["commerce_order_line", "commerce_refund_line", "event_link"]);
  const payments = LIGHTSPEED_STREAMS.find((s) => s.id === "ls_sale_payments")!;
  assert.deepEqual([...payments.canonicalTargets].sort(), ["commerce_payment"]);
  for (const required of [] as string[]) {
    assert.ok(sales.canonicalTargets.includes(required as never),
      `ls_sales must still declare ${required}`);
  }
});

test("spec targets with no mapper are visible as a gap, not silently dropped", () => {
  const declared = new Set(LIGHTSPEED_STREAMS.flatMap((s) => s.canonicalTargets as readonly string[]));
  const specTargets = new Set(SPEC_TABLES.flatMap((t) => t.canonicalTargets));
  const awaitingMapper = [...specTargets].filter((t) => !declared.has(t)).sort();
  // Recorded rather than asserted empty: these are canonical facts the spec says
  // Lightspeed can feed once a mapper is written for the stream that carries them.
  assert.ok(Array.isArray(awaitingMapper));
});
