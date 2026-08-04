import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import {
  RawBatchConflictError,
  RawBatchWriter,
  type RawBatchManifest,
  type RawManifestRepository,
  type RawObjectStore,
} from "./src/index.js";

const ids = {
  tenantId: "01J00000000000000000000001",
  connectionId: "01J00000000000000000000002",
  syncRunId: "01J00000000000000000000003",
  batchId: "01J00000000000000000000004",
} as const;

class MemoryStore implements RawObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  writes = 0;

  async putIfAbsent(input: Parameters<RawObjectStore["putIfAbsent"]>[0]) {
    if (this.objects.has(input.key)) return "exists" as const;
    this.objects.set(input.key, input.body);
    this.writes += 1;
    return "created" as const;
  }

  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
}

class MemoryManifests implements RawManifestRepository {
  readonly values = new Map<string, RawBatchManifest>();

  async find(tenantId: string, batchId: string) {
    return this.values.get(`${tenantId}:${batchId}`) ?? null;
  }

  async registerUploaded(manifest: RawBatchManifest) {
    const key = `${manifest.tenantId}:${manifest.batchId}`;
    if (this.values.has(key)) throw new Error("manifest exists");
    this.values.set(key, manifest);
  }
}

function withContentIdentityLookup(manifests: MemoryManifests): RawManifestRepository {
  return {
    find:manifests.find.bind(manifests),
    registerUploaded:manifests.registerUploaded.bind(manifests),
    async findByContentIdentity(identity) {
      for (const manifest of manifests.values.values()) {
        if (
          manifest.tenantId === identity.tenantId &&
          manifest.syncRunId === identity.syncRunId &&
          manifest.connectionId === identity.connectionId &&
          manifest.stream === identity.stream &&
          manifest.contentHash === identity.contentHash &&
          JSON.stringify(manifest.cursorStart) === JSON.stringify(identity.cursorStart) &&
          JSON.stringify(manifest.cursorEnd) === JSON.stringify(identity.cursorEnd)
        ) return manifest;
      }
      return null;
    },
  };
}

const context = {
  ...ids,
  connectorKey: "stub",
  connectorVersion: "1.0.0",
  apiVersion: "fixture-v1",
  externalAccountReference: "shop-1",
  stream: "sales",
  extractedAt: "2026-08-03T10:15:00.000Z",
  cursorStart: { value: "100" },
  cursorEnd: { value: "200" },
} as const;

function hash(value: unknown) {
  const stable = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(stable).join(",")}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  };
  return createHash("sha256").update(stable(value)).digest("hex");
}

const payload = { id: "sale-1", total: "12.3400", nested: { b: 2, a: 1 } } as const;

const records = [
  {
    sourceObjectType: "Sale",
    sourceRecordId: "sale-1",
    sourceUpdatedAt: "2026-08-03T10:14:59.000Z",
    payloadHash: hash(payload),
    payload,
  },
] as const;

test("raw writer produces immutable compressed JSONL and idempotently resumes", async () => {
  const store = new MemoryStore();
  const manifests = new MemoryManifests();
  const writer = new RawBatchWriter(store, manifests);

  const first = await writer.write(context, records);
  const resumed = await writer.write(context, records);

  assert.deepEqual(resumed, first);
  assert.equal(store.writes, 1);
  assert.match(first.objectKeys[0], /tenant\/01J.*\/batch-01J.*\.jsonl\.gz$/);
  const body = store.objects.get(first.objectKeys[0]);
  assert.ok(body);
  const jsonl = gunzipSync(body).toString("utf8");
  assert.equal(jsonl.split("\n").filter(Boolean).length, 1);
  assert.match(jsonl, /"payload":\{"id":"sale-1","nested":\{"a":1,"b":2\},"total":"12.3400"\}/);
});

test("reusing a batch id with different content is rejected", async () => {
  const writer = new RawBatchWriter(new MemoryStore(), new MemoryManifests());
  await writer.write(context, records);
  await assert.rejects(
    writer.write(context, [
      {
        ...records[0],
        payloadHash: hash({ id: "sale-1", total: "999.0000" }),
        payload: { id: "sale-1", total: "999.0000" },
      },
    ]),
    RawBatchConflictError,
  );
});

test("a replayed page in the same sync run reuses the original immutable batch", async () => {
  const store = new MemoryStore();
  const manifests = new MemoryManifests();
  const writer = new RawBatchWriter(store, withContentIdentityLookup(manifests));

  const original = await writer.write(context, records);
  const replayed = await writer.write(
    { ...context, batchId: "01J00000000000000000000009" },
    records,
  );

  assert.deepEqual(replayed, original);
  assert.equal(store.writes, 1);
  assert.equal(manifests.values.size, 1);
});

test("identical pages in distinct sync runs retain distinct immutable lineage", async () => {
  const store = new MemoryStore();
  const manifests = new MemoryManifests();
  const writer = new RawBatchWriter(store, withContentIdentityLookup(manifests));

  const original = await writer.write(context, records);
  const nextRun = await writer.write(
    {
      ...context,
      batchId: "01J00000000000000000000009",
      syncRunId: "01J0000000000000000000000A",
    },
    records,
  );

  assert.notEqual(nextRun.batchId, original.batchId);
  assert.notEqual(nextRun.syncRunId, original.syncRunId);
  assert.equal(nextRun.contentHash, original.contentHash);
  assert.equal(store.writes, 2);
  assert.equal(manifests.values.size, 2);
});

test("raw writer verifies and registers an object left behind before manifest commit", async () => {
  const store = new MemoryStore();
  const failedManifests = new MemoryManifests();
  const firstWriter = new RawBatchWriter(store, {
    find: failedManifests.find.bind(failedManifests),
    async registerUploaded() { throw new Error("database unavailable"); },
  });
  await assert.rejects(firstWriter.write(context, records), RawBatchConflictError);
  assert.equal(store.writes, 1);

  const recoveredManifests = new MemoryManifests();
  const recovered = await new RawBatchWriter(store, recoveredManifests).write(context, records);
  assert.equal(store.writes, 1);
  assert.deepEqual(await recoveredManifests.find(context.tenantId, context.batchId), recovered);
});
