import assert from "node:assert/strict";
import test from "node:test";
import { RawStoragePurger, type RawDeletionObjectStore } from "./raw-storage.js";

class MemoryObjects implements RawDeletionObjectStore {
  readonly files = new Set<string>();

  async listPrefix(prefix: string) {
    return {
      keys: [...this.files].filter((key) => key.startsWith(prefix)).sort().slice(0, 1_000),
    };
  }

  async deleteKeys(keys: readonly string[]) {
    keys.forEach((key) => this.files.delete(key));
  }
}

test("raw purge deletes only the exact connection prefix and verifies the result", async () => {
  const tenant = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const target = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const retained = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const objects = new MemoryObjects();
  objects.files.add(`tenant/${tenant}/connection/${target}/run/batch/records.ndjson.gz`);
  objects.files.add(`tenant/${tenant}/connection/${target}/run/batch/manifest.json.gz`);
  objects.files.add(`tenant/${tenant}/connection/${retained}/run/batch/records.ndjson.gz`);
  const purger = new RawStoragePurger(objects);

  const result = await purger.purge(tenant, target);

  assert.equal(result.verified, true);
  assert.equal(result.objectsRemoved, 2);
  assert.deepEqual([...objects.files], [
    `tenant/${tenant}/connection/${retained}/run/batch/records.ndjson.gz`,
  ]);
});

test("tenant purge removes more than one S3 page without stale cursors", async () => {
  const tenant = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const objects = new MemoryObjects();
  for (let index = 0; index < 1_205; index += 1) {
    objects.files.add(
      `tenant/${tenant}/connection/01ARZ3NDEKTSV4RRFFQ69G5FAW/run/batch/${String(index).padStart(4, "0")}.gz`,
    );
  }
  const purger = new RawStoragePurger(objects);

  assert.equal((await purger.purge(tenant, null)).objectsRemoved, 1_205);
  assert.equal((await purger.verify(tenant, null)).remainingObjects, 0);
});

test("raw purge rejects a broad or malformed deletion scope", async () => {
  await assert.rejects(
    new RawStoragePurger(new MemoryObjects()).purge("tenant", null),
    /raw_deletion_scope_invalid/,
  );
});
