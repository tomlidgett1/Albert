import assert from "node:assert/strict";
import test from "node:test";
import { CodexRuntimeHttpHandler } from "./src/http.js";
import type { OmniJobStore } from "./src/omni-job-store.js";

// The durable snapshot (turn, every trace event, the model history and all
// evidence, up to 48 MB encrypted) used to be rewritten once per trace event,
// every emit waited on that write, and one busy-database error failed the
// whole analysis.
function harness(save: (snapshot: { events: readonly unknown[] }) => Promise<number>) {
  const store = { save: async (_job: unknown, snapshot: { events: readonly unknown[] }) => save(snapshot), renew: async () => true, release: async () => undefined, close: async () => undefined } as unknown as OmniJobStore;
  const handler = new CodexRuntimeHttpHandler(Object.freeze({
    port: 8792, listenHost: "127.0.0.1" as const, signingSecret: "h".repeat(48), cubeApiUrl: "https://cube.example.test",
    authentication: { mode: "api" as const, apiKey: "sk-fixture", baseUrl: "https://au.api.openai.com/v1" },
    maxConcurrentTurns: 2, pinnedCliVersion: "0.148.0", releaseSha: "development", deploymentId: "test",
  }) as never, store);
  const job = {
    id: "job", events: [] as unknown[], waiters: new Set(), abort: new AbortController(), createdAt: 0, updatedAt: 0, lastPolledAt: 0, eventBytes: 0,
    durable: { id: "job", tenantId: "t", requestHash: "h", revision: 1, owner: "w", leaseUntil: 0, snapshot: {} },
    omniTurn: { requestId: "job" }, deadlineAt: Date.now() + 60_000,
  };
  const internals = handler as unknown as { saveOmniJob: (target: typeof job) => Promise<void> };
  return { handler, job, save: () => internals.saveOmniJob(job) };
}

test("durable saves coalesce while one is in flight and ride out a busy database", async () => {
  const saved: number[] = [];
  let calls = 0;
  const { handler, job, save } = harness(async (snapshot) => {
    calls += 1;
    if (calls === 1) throw new Error("Connection terminated unexpectedly");
    saved.push(snapshot.events.length);
    return calls;
  });
  const pending = [];
  for (let index = 0; index < 20; index += 1) {
    job.events.push({ index });
    pending.push(save());
  }
  await Promise.all(pending);
  assert.equal(job.abort.signal.aborted, false);
  assert.ok(calls <= 4, `twenty events took ${calls} saves`);
  assert.equal(saved.at(-1), 20, "the last save holds every event");
  await handler.close();
});

test("a lost lease is final: the job stops instead of retrying", async () => {
  let calls = 0;
  const { handler, job, save } = harness(async () => {
    calls += 1;
    throw new Error("The durable job lease was lost; this worker may not publish more results.");
  });
  job.events.push({ index: 0 });
  await assert.rejects(save(), /lease was lost/u);
  assert.equal(calls, 1);
  assert.equal(job.abort.signal.aborted, true);
  await handler.close();
});
