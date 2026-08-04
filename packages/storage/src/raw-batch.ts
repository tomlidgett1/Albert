import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export type RawBatchRecord = Readonly<{
  sourceObjectType: string;
  sourceRecordId: string;
  sourceUpdatedAt?: string;
  payloadHash: string;
  payload: JsonValue;
}>;

export type RawBatchContext = Readonly<{
  tenantId: string;
  connectionId: string;
  syncRunId: string;
  batchId: string;
  connectorKey: string;
  connectorVersion: string;
  apiVersion: string;
  externalAccountReference: string;
  stream: string;
  extractedAt: string;
  cursorStart: JsonValue | null;
  cursorEnd: JsonValue | null;
}>;

export type RawBatchManifest = Readonly<{
  tenantId: string;
  connectionId: string;
  syncRunId: string;
  batchId: string;
  connectorKey: string;
  connectorVersion: string;
  apiVersion: string;
  externalAccountReference: string;
  stream: string;
  extractedAt: string;
  cursorStart: JsonValue | null;
  cursorEnd: JsonValue | null;
  contentHash: string;
  schemaFingerprint: string;
  recordCount: number;
  compressedBytes: number;
  objectKeys: readonly [string];
}>;

export interface RawObjectStore {
  /** Must never overwrite; an existing key is reported for byte verification. */
  putIfAbsent(input: Readonly<{
    key: string;
    body: Uint8Array;
    contentType: "application/gzip";
    metadata: Readonly<Record<string, string>>;
  }>): Promise<"created" | "exists">;
  /** Used only to verify a crash-resumed immutable key before registering it. */
  read(key: string): Promise<Uint8Array | null>;
}

export type RawBatchContentIdentity = Readonly<{
  tenantId: string;
  syncRunId: string;
  connectionId: string;
  stream: string;
  contentHash: string;
  cursorStart: JsonValue | null;
  cursorEnd: JsonValue | null;
}>;

export interface RawManifestRepository {
  find(tenantId: string, batchId: string): Promise<RawBatchManifest | null>;
  /**
   * Finds a manifest already registered under the same run-scoped immutable
   * content identity. A recovered multi-page claim can mint a fresh batchId
   * while replaying its last uncommitted page; reusing that run's original
   * batch keeps the retry idempotent without collapsing distinct sync runs.
   */
  findByContentIdentity?(
    identity: RawBatchContentIdentity,
  ): Promise<RawBatchManifest | null>;
  /** Inserts the immutable manifest and its initial uploaded landing state atomically. */
  registerUploaded(manifest: RawBatchManifest): Promise<void>;
}

export class RawBatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawBatchConflictError";
  }
}

export class RawBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawBatchValidationError";
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertJsonValue(value: unknown, path = "payload", depth = 0): asserts value is JsonValue {
  if (depth > 80) throw new RawBatchValidationError(`${path} exceeds the maximum JSON depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RawBatchValidationError(`${path} contains a non-finite number.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object" && value !== undefined) {
    for (const [key, child] of Object.entries(value)) {
      if (key.includes("\u0000")) {
        throw new RawBatchValidationError(`${path} contains an invalid object key.`);
      }
      assertJsonValue(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new RawBatchValidationError(`${path} is not JSON-serialisable.`);
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key]!)}`)
    .join(",")}}`;
}

function typeShape(value: JsonValue): JsonValue {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const shapes = [...new Set(value.map((item) => stableJson(typeShape(item))))]
      .sort()
      .map((item) => JSON.parse(item) as JsonValue);
    return { type: "array", items: shapes };
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, JsonValue>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, typeShape(record[key]!)]),
    );
  }
  return typeof value;
}

function validateContext(context: RawBatchContext): Date {
  for (const [label, value] of [
    ["tenantId", context.tenantId],
    ["connectionId", context.connectionId],
    ["syncRunId", context.syncRunId],
    ["batchId", context.batchId],
  ] as const) {
    if (!ULID_PATTERN.test(value)) {
      throw new RawBatchValidationError(`${label} must be a canonical uppercase ULID.`);
    }
  }
  for (const [label, value] of [
    ["connectorKey", context.connectorKey],
    ["stream", context.stream],
  ] as const) {
    if (!SAFE_KEY_SEGMENT.test(value)) {
      throw new RawBatchValidationError(`${label} is not safe for an immutable object key.`);
    }
  }
  for (const [label, value] of [
    ["connectorVersion", context.connectorVersion],
    ["apiVersion", context.apiVersion],
    ["externalAccountReference", context.externalAccountReference],
  ] as const) {
    if (!value.trim()) throw new RawBatchValidationError(`${label} must not be empty.`);
  }
  const extractedAt = new Date(context.extractedAt);
  if (Number.isNaN(extractedAt.valueOf())) {
    throw new RawBatchValidationError("extractedAt must be an ISO-8601 timestamp.");
  }
  assertJsonValue(context.cursorStart, "cursorStart");
  assertJsonValue(context.cursorEnd, "cursorEnd");
  return extractedAt;
}

export function buildRawObjectKey(context: RawBatchContext): string {
  const extractedAt = validateContext(context);
  const date = extractedAt.toISOString().slice(0, 10);
  return [
    "tenant",
    context.tenantId,
    "connection",
    context.connectionId,
    "stream",
    context.stream,
    "date",
    date,
    `batch-${context.batchId}.jsonl.gz`,
  ].join("/");
}

function assertMatchingManifest(
  existing: RawBatchManifest,
  expected: RawBatchManifest,
): RawBatchManifest {
  if (
    existing.contentHash !== expected.contentHash ||
    existing.schemaFingerprint !== expected.schemaFingerprint ||
    existing.objectKeys[0] !== expected.objectKeys[0] ||
    existing.recordCount !== expected.recordCount
  ) {
    throw new RawBatchConflictError(
      `Batch ${expected.batchId} already exists with different immutable content.`,
    );
  }
  return existing;
}

export class RawBatchWriter {
  constructor(
    private readonly objectStore: RawObjectStore,
    private readonly manifests: RawManifestRepository,
  ) {}

  async write(
    context: RawBatchContext,
    records: readonly RawBatchRecord[],
  ): Promise<RawBatchManifest> {
    validateContext(context);
    const recordIds = new Set<string>();
    const lines = records.map((record, index) => {
      if (!record.sourceObjectType.trim() || !record.sourceRecordId.trim()) {
        throw new RawBatchValidationError(`records[${index}] has no source identity.`);
      }
      if (!SHA256_PATTERN.test(record.payloadHash)) {
        throw new RawBatchValidationError(`records[${index}].payloadHash is not SHA-256.`);
      }
      assertJsonValue(record.payload, `records[${index}].payload`);
      if (sha256(stableJson(record.payload)) !== record.payloadHash) {
        throw new RawBatchValidationError(
          `records[${index}].payloadHash does not match the immutable payload bytes.`,
        );
      }
      const identity = `${record.sourceObjectType}\u0000${record.sourceRecordId}`;
      if (recordIds.has(identity)) {
        throw new RawBatchValidationError(`Batch contains duplicate source identity at records[${index}].`);
      }
      recordIds.add(identity);
      const envelope: JsonValue = {
        sourceObjectType: record.sourceObjectType,
        sourceRecordId: record.sourceRecordId,
        ...(record.sourceUpdatedAt ? { sourceUpdatedAt: record.sourceUpdatedAt } : {}),
        payloadHash: record.payloadHash,
        payload: record.payload,
      };
      return stableJson(envelope);
    });
    const jsonl = `${lines.join("\n")}${lines.length ? "\n" : ""}`;
    const uncompressed = new TextEncoder().encode(jsonl);
    const compressed = gzipSync(uncompressed, { level: 9 });
    const objectKey = buildRawObjectKey(context);
    const manifest: RawBatchManifest = Object.freeze({
      tenantId: context.tenantId,
      connectionId: context.connectionId,
      syncRunId: context.syncRunId,
      batchId: context.batchId,
      connectorKey: context.connectorKey,
      connectorVersion: context.connectorVersion,
      apiVersion: context.apiVersion,
      externalAccountReference: context.externalAccountReference,
      stream: context.stream,
      extractedAt: new Date(context.extractedAt).toISOString(),
      cursorStart: context.cursorStart,
      cursorEnd: context.cursorEnd,
      contentHash: sha256(uncompressed),
      schemaFingerprint: sha256(
        stableJson(records.map((record) => typeShape(record.payload))),
      ),
      recordCount: records.length,
      compressedBytes: compressed.byteLength,
      objectKeys: Object.freeze([objectKey]) as readonly [string],
    });

    const existing = await this.manifests.find(context.tenantId, context.batchId);
    if (existing) {
      const matched = assertMatchingManifest(existing, manifest);
      const priorBytes = await this.objectStore.read(objectKey);
      if (!priorBytes || sha256(priorBytes) !== sha256(compressed)) {
        throw new RawBatchConflictError(
          `Manifest ${context.batchId} does not match an intact immutable raw object.`,
        );
      }
      return matched;
    }

    // A recovered claim can re-extract its last uncommitted page under a fresh
    // batchId. Reuse identical content only inside that exact sync run. A new
    // scheduled run must retain its own batch, landing, and quality lineage
    // even when the vendor snapshot is byte-for-byte unchanged.
    const findReplayed = async (): Promise<RawBatchManifest | null> => {
      if (!this.manifests.findByContentIdentity) return null;
      const replayed = await this.manifests.findByContentIdentity({
        tenantId: context.tenantId,
        syncRunId: context.syncRunId,
        connectionId: context.connectionId,
        stream: context.stream,
        contentHash: manifest.contentHash,
        cursorStart: context.cursorStart,
        cursorEnd: context.cursorEnd,
      });
      if (!replayed) return null;
      if (
        replayed.schemaFingerprint !== manifest.schemaFingerprint ||
        replayed.recordCount !== manifest.recordCount ||
        replayed.objectKeys.length !== 1
      ) {
        throw new RawBatchConflictError(
          `Batch content for stream ${context.stream} is already registered with different immutable evidence.`,
        );
      }
      return replayed;
    };
    const replayed = await findReplayed();
    if (replayed) return replayed;

    const upload = await this.objectStore.putIfAbsent({
      key: objectKey,
      body: compressed,
      contentType: "application/gzip",
      metadata: Object.freeze({
        batchId: context.batchId,
        contentSha256: manifest.contentHash,
        compressedSha256: sha256(compressed),
        schemaSha256: manifest.schemaFingerprint,
      }),
    });
    if (upload === "exists") {
      const priorBytes = await this.objectStore.read(objectKey);
      if (!priorBytes || sha256(priorBytes) !== sha256(compressed)) {
        throw new RawBatchConflictError(
          `Raw object ${objectKey} already exists with different immutable bytes.`,
        );
      }
    }

    try {
      await this.manifests.registerUploaded(manifest);
    } catch (error) {
      const concurrent = await this.manifests.find(context.tenantId, context.batchId);
      if (concurrent) return assertMatchingManifest(concurrent, manifest);
      // A concurrent retry of this run may have registered the same page
      // identity between the lookup above and this insert.
      const replayedAfterConflict = await findReplayed();
      if (replayedAfterConflict) return replayedAfterConflict;
      throw new RawBatchConflictError(
        `Raw object ${objectKey} was written but its manifest could not be registered: ${
          error instanceof Error ? error.message : "unknown manifest error"
        }`,
      );
    }
    return manifest;
  }
}
