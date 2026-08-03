import assert from "node:assert/strict";
import test from "node:test";
import { loadReplicaWorkerId } from "../../packages/shared/src/index.js";

test("worker lease identities are unique for every Fly machine", () => {
  assert.equal(
    loadReplicaWorkerId(
      { NODE_ENV: "test", ALBERT_WORKER_ID: "sync", FLY_MACHINE_ID: "90801abcdef123" },
      "ALBERT_WORKER_ID",
      "missing",
    ),
    "sync:90801abcdef123",
  );
  assert.equal(
    loadReplicaWorkerId(
      { NODE_ENV: "test", ALBERT_WORKER_ID: "sync", FLY_MACHINE_ID: "91801abcdef456" },
      "ALBERT_WORKER_ID",
      "missing",
    ),
    "sync:91801abcdef456",
  );
});

test("non-Fly runtimes can provide an explicit replica identity", () => {
  assert.equal(
    loadReplicaWorkerId(
      {
        NODE_ENV: "test",
        ALBERT_WORKER_ID: "sync",
        ALBERT_WORKER_INSTANCE_ID: "pod-3",
      },
      "ALBERT_WORKER_ID",
      "missing",
    ),
    "sync:pod-3",
  );
});

test("worker identity configuration fails closed for missing or malformed values", () => {
  assert.throws(
    () => loadReplicaWorkerId({ NODE_ENV: "test" }, "ALBERT_WORKER_ID", "worker id missing"),
    /worker id missing/,
  );
  assert.throws(
    () => loadReplicaWorkerId(
      { NODE_ENV: "production", ALBERT_WORKER_ID: "sync" },
      "ALBERT_WORKER_ID",
      "missing",
    ),
    /requires FLY_MACHINE_ID or ALBERT_WORKER_INSTANCE_ID in production/,
  );
  assert.throws(
    () => loadReplicaWorkerId(
      {
        NODE_ENV: "test",
        ALBERT_WORKER_ID: "sync",
        FLY_MACHINE_ID: "machine id with spaces",
      },
      "ALBERT_WORKER_ID",
      "missing",
    ),
    /runtime instance identifier is invalid/,
  );
});
