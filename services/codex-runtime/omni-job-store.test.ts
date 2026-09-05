import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ulid } from "ulid";
import { FileOmniJobStore, type OmniJobSnapshot } from "./src/omni-job-store.js";
import { PostgresOmniJobStore } from "./src/omni-job-store.js";
import { Pool } from "pg";

const secret = "synthetic-job-store-fixture-key-0000000000";
function snapshot(): OmniJobSnapshot {
  return { createdAt: Date.now(), deadlineAt: Date.now() + 720_000, events: [], turn: {
    protocolVersion: 1, requestId: ulid(), tenantId: ulid(), actorId: randomUUID(), role: "owner", conversationId: ulid(), turnId: ulid(),
    message: "Private fixture operands must stay encrypted", priorConversation: [], activeConnectors: [], connectorFreshness: [],
    cubeBearer: "synthetic.fixture.bearer", model: "gpt-5.6-luna", effort: "max", fastMode: false,
  } };
}

test("durable jobs survive a separate process and do not write plaintext turn data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omni-job-restart-"));
  const state = snapshot();
  try {
    const script = `import {readFileSync} from 'node:fs'; import {FileOmniJobStore} from './services/codex-runtime/src/omni-job-store.ts'; const value=JSON.parse(readFileSync(0,'utf8')); const store=new FileOmniJobStore(process.env.OMNI_TEST_DIRECTORY, '${secret}'); await store.create(value); const job=await store.claim(value.turn.requestId,'11111111-1111-4111-8111-111111111111'); value.events.push({type:'progress',status:'running',stage:'planning',label:'Saved step'}); await store.save(job,value); await store.release(job.id,job.owner); await store.close();`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, OMNI_TEST_DIRECTORY: directory }, input: JSON.stringify(state), encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
    const store = new FileOmniJobStore(directory, secret);
    const restored = await store.claim(state.turn.requestId, randomUUID());
    assert.ok(restored);
    assert.equal(restored.snapshot.events.length, 1);
    assert.equal(restored.snapshot.turn.message, state.turn.message);
    await store.close();
    for (const name of await readdir(directory)) {
      const bytes = await readFile(join(directory, name));
      assert.equal(bytes.includes(Buffer.from(state.turn.message)), false);
      assert.equal(bytes.includes(Buffer.from(state.turn.cubeBearer)), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("leases and revisions fence concurrent workers and stale checkpoint writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omni-job-fencing-"));
  const a = new FileOmniJobStore(directory, secret), b = new FileOmniJobStore(directory, secret);
  try {
    const state = snapshot(); await a.create(state);
    const ownerA = randomUUID(), ownerB = randomUUID();
    const first = await a.claim(state.turn.requestId, ownerA); assert.ok(first);
    assert.equal(await b.claim(state.turn.requestId, ownerB), null);
    const revision = await a.save(first, state);
    await assert.rejects(a.save(first, state), /lease was lost/u);
    first.revision = revision;
    await a.release(first.id, ownerA);
    const second = await b.claim(first.id, ownerB); assert.ok(second);
    await assert.rejects(a.save(first, state), /lease was lost/u);
    state.result = { answerState: "Verified", durationMs: 100, modelRequests: 1, queriesExecuted: 1 };
    await b.save(second, state);
    assert.equal((await a.get(first.id))?.snapshot.result?.answerState, "Verified");
    assert.equal(await a.claim(first.id, ownerA), null);
  } finally { await a.close(); await b.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a job ID cannot be reused across tenants or changed input, and ciphertext needs its key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omni-job-isolation-"));
  const store = new FileOmniJobStore(directory, secret);
  const wrongKey = new FileOmniJobStore(directory, "different-synthetic-key-00000000000000");
  try {
    const state = snapshot(); await store.create(state);
    await assert.rejects(store.create({ ...state, turn: { ...state.turn, tenantId: ulid() } }), /different input/u);
    await assert.rejects(store.create({ ...state, turn: { ...state.turn, message: "Changed" } }), /different input/u);
    await assert.rejects(wrongKey.get(state.turn.requestId));
    await assert.rejects(store.get("../another-job"), /Invalid durable job identity/u);
  } finally { await store.close(); await wrongKey.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Postgres operations pin the isolated role to one transaction and roll back failures", async (context) => {
  const statements: string[] = []; let released = 0; let fail = false;
  context.mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string) => { statements.push(sql); if (fail && sql.startsWith("UPDATE")) throw new Error("write failed"); return { rows: [], rowCount: 1 }; },
    release: () => { released++; },
  }));
  const store = new PostgresOmniJobStore("postgresql://fixture@127.0.0.1/fixture", secret);
  try {
    await store.release(ulid(), randomUUID());
    assert.equal(statements[0], "BEGIN");
    assert.equal(statements[1], "SET LOCAL ROLE albert_omni_control");
    assert.equal(statements.at(-1), "COMMIT");
    fail = true;
    await assert.rejects(store.release(ulid(), randomUUID()), /write failed/u);
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(released, 2);
  } finally { await store.close(); }
});
