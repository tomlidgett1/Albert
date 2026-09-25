import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { squareManifest } from "../../connectors/square/manifest.js";
import {
  SQUARE_READ_STREAMS,
  squareHasCompleteIdentityScan,
  squareReadStream,
} from "../../connectors/square/streams.js";
import {
  assertConnectorManifestReconciliationPolicy,
  type ConnectorManifest,
} from "../../packages/connector-sdk/src/index.js";

const contractById = new Map(squareManifest.streams.map((stream) => [stream.id, stream]));

test("Square bounded reconciliation can never use historical absence as delete evidence", () => {
  assert.doesNotThrow(() => assertConnectorManifestReconciliationPolicy(squareManifest));
  for (const stream of SQUARE_READ_STREAMS) {
    const contract = contractById.get(stream.id);
    assert.ok(contract, `${stream.id} is missing from the Square manifest`);
    const complete = squareHasCompleteIdentityScan(stream);
    if (!complete
      && stream.deletion.strategy !== "soft_delete_field"
      && stream.deletion.strategy !== "immutable") {
      assert.equal(contract.deletionStrategy, "no_absence_deletes", stream.id);
    }
    if (contract.deletionStrategy === "authoritative_identity_scan") {
      assert.equal(complete, true, `${stream.id} claims authority from a bounded identity scan`);
    }
    assert.equal(
      contract.sourceTotalStrategy,
      complete ? "count_distinct_complete_scan" : "count_distinct_bounded_scan",
      `${stream.id} misstates the population covered by its reconciliation total`,
    );
  }
});

test("the connector SDK rejects deletion authority over an explicitly bounded population", () => {
  const unsafe = {
    ...squareManifest,
    streams: squareManifest.streams.map((stream) => stream.id === "square_orders"
      ? {
          ...stream,
          deletionStrategy: "authoritative_identity_scan",
          sourceTotalStrategy: "count_distinct_bounded_scan",
        }
      : stream),
  } as ConnectorManifest;
  assert.throws(
    () => assertConnectorManifestReconciliationPolicy(unsafe),
    /cannot infer deletion from a bounded source population/iu,
  );
});

test("time-windowed parent fan-outs inherit the exact parent's incomplete identity boundary", () => {
  const boundedChildren = [
    "square_order_custom_attributes",
    "square_cash_drawer_shift_events",
    "square_payout_entries",
    "square_booking_custom_attributes",
  ] as const;
  for (const id of boundedChildren) {
    const stream = squareReadStream(id);
    assert.equal(stream.backfill.mode, "parent_fan_out");
    assert.equal(squareHasCompleteIdentityScan(stream), false, id);
    const contract = contractById.get(id);
    const expected = stream.deletion.strategy === "immutable"
      ? "immutable_append_only"
      : "no_absence_deletes";
    assert.equal(contract?.deletionStrategy, expected, id);
    assert.equal(contract?.sourceTotalStrategy, "count_distinct_bounded_scan", id);
  }
});

test("Square keeps explicit soft deletes and genuine complete scans correctly classified", () => {
  assert.equal(contractById.get("square_catalog_objects")?.deletionStrategy, "soft_delete");

  for (const id of ["square_orders", "square_payments", "square_refunds", "square_payouts"]) {
    const contract = contractById.get(id);
    assert.equal(contract?.deletionStrategy, "no_absence_deletes", id);
    assert.equal(contract?.lateEditStrategy, "modified_field", id);
    assert.equal(contract?.sourceTotalStrategy, "count_distinct_bounded_scan", id);
  }

  for (const id of [
    "square_merchants",
    "square_locations",
    "square_customers",
    "square_team_member_wage_settings",
    "square_disputes",
    "square_snippets",
  ]) {
    assert.equal(squareHasCompleteIdentityScan(squareReadStream(id)), true, id);
    assert.equal(contractById.get(id)?.deletionStrategy, "authoritative_identity_scan", id);
    assert.equal(contractById.get(id)?.sourceTotalStrategy, "count_distinct_complete_scan", id);
  }

  assert.match(
    squareManifest.limitations.join(" "),
    /bounded time-window reconciliation is never treated as proof that older identities were deleted/iu,
  );
  assert.match(squareManifest.limitations.join(" "), /distinct source total describes only the bounded scan/iu);
});

test("durable reconciliation migrations admit bounded mutable scans without enabling tombstones", () => {
  const control = readFileSync(
    new URL("../../infra/migrations/control-plane/0128_m2_no_absence_delete_reconciliation.sql", import.meta.url),
    "utf8",
  );
  const analytical = readFileSync(
    new URL("../../infra/migrations/analytical/0151_m2_no_absence_delete_reconciliation.sql", import.meta.url),
    "utf8",
  );

  for (const migration of [control, analytical]) {
    assert.match(migration, /no_absence_deletes/u);
    assert.match(migration, /count_distinct_bounded_scan/u);
    assert.match(
      migration,
      /deletion_strategy<>'authoritative_identity_scan'[\s\S]+source_total_strategy<>'count_distinct_bounded_scan'/u,
    );
  }
  assert.match(control, /p_deletion_strategy='authoritative_identity_scan'[\s\S]+p_source_total_strategy='count_distinct_bounded_scan'/u);
  assert.match(analytical, /first_scan\.deletion_strategy=''authoritative_identity_scan''/u);
  assert.match(analytical, /verified_source_total_strategy='count_distinct_bounded_scan'/u);
  assert.match(analytical, /source_total=verified_source_total,local_live_total=NULL/u);
  assert.match(analytical, /source_total_strategy<>''count_distinct_bounded_scan''/u);
  assert.match(analytical, /state\.source_total_strategy<>''count_distinct_bounded_scan''/u);
  assert.match(analytical, /current_scoped_health/u);
});
