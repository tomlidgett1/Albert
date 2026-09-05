import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Pool } from "pg";
import type { OmniServiceTurn, OmniSemanticTurnResult } from "../../../packages/albert-omni/src/contracts.js";
import type { OmniTurnCheckpoint } from "../../../packages/albert-omni/src/checkpoint.js";
import type { OmniTraceEventInput } from "../../../packages/albert-omni/src/runtime.js";
import type { CodexQueryAuditEvent } from "../../../packages/albert-codex/src/contracts.js";

export type OmniJobSnapshot = {
  turn: OmniServiceTurn;
  createdAt: number;
  deadlineAt: number;
  events: (OmniTraceEventInput | CodexQueryAuditEvent)[];
  checkpoint?: OmniTurnCheckpoint;
  result?: OmniSemanticTurnResult;
  failure?: { code: string; message: string };
};
export type StoredOmniJob = {
  id: string;
  tenantId: string;
  requestHash: string;
  revision: number;
  owner: string | null;
  leaseUntil: number;
  snapshot: OmniJobSnapshot;
};
export interface OmniJobStore {
  create(snapshot: OmniJobSnapshot): Promise<StoredOmniJob>;
  get(id: string): Promise<StoredOmniJob | null>;
  claim(id: string, owner: string): Promise<StoredOmniJob | null>;
  save(job: StoredOmniJob, snapshot: OmniJobSnapshot): Promise<number>;
  renew(id: string, owner: string): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
  close(): Promise<void>;
}
const LEASE_MS = 90_000;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_STATE_BYTES = 48 * 1024 * 1024;
const jobPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
export function omniRequestHash(turn: OmniServiceTurn): string {
  return createHash("sha256").update(JSON.stringify(turn)).digest("hex");
}
function assertId(id: string) { if (!jobPattern.test(id)) throw new Error("Invalid durable job identity."); }

class JobCipher {
  private readonly key: Buffer;
  constructor(secret: string) { this.key = createHash("sha256").update(`albert-omni-jobs:v1\0${secret}`).digest(); }
  encrypt(id: string, snapshot: OmniJobSnapshot): Buffer {
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("The durable job checkpoint exceeded its size bound.");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }
  decrypt(id: string, buffer: Buffer): OmniJobSnapshot {
    if (buffer.length < 29 || buffer.length > MAX_STATE_BYTES + 28) throw new Error("Invalid durable job checkpoint.");
    const cipher = createDecipheriv("aes-256-gcm", this.key, buffer.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(buffer.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString("utf8")) as OmniJobSnapshot;
    if (value.turn?.requestId !== id || !Array.isArray(value.events)) throw new Error("The durable job checkpoint has the wrong identity.");
    return value;
  }
}

/** Production store. The database login has access only to this encrypted job table. */
export class PostgresOmniJobStore implements OmniJobStore {
  private readonly pool: Pool;
  private readonly cipher: JobCipher;
  constructor(databaseUrl: string, secret: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
    this.pool.on("error", () => process.stderr.write('{"event":"omni_job_store_idle_connection_failed"}\n'));
    this.cipher = new JobCipher(secret);
  }
  private async query(sql: string, values: unknown[] = []) {
    const client = await this.pool.connect();
    try {
      // Keep role activation and the statement on the same backend even on
      // Supavisor's transaction pooler; never leak a session role to a pool.
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_omni_control");
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  private decode(row: Record<string, unknown>): StoredOmniJob {
    const id = String(row.job_id);
    const snapshot = this.cipher.decrypt(id, row.snapshot as Buffer);
    if (snapshot.turn.tenantId !== row.tenant_id || omniRequestHash(snapshot.turn) !== row.request_hash) throw new Error("The encrypted job does not match its tenant and request identity.");
    return { id, tenantId: String(row.tenant_id), requestHash: String(row.request_hash), revision: Number(row.revision), owner: row.lease_owner ? String(row.lease_owner) : null, leaseUntil: row.lease_until ? new Date(String(row.lease_until)).getTime() : 0, snapshot };
  }
  async create(snapshot: OmniJobSnapshot): Promise<StoredOmniJob> {
    const { turn } = snapshot; assertId(turn.requestId);
    const hash = omniRequestHash(turn);
    await this.query(`INSERT INTO control_plane.omni_runtime_jobs
      (job_id, tenant_id, turn_id, actor_id, request_hash, snapshot, deadline_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (job_id) DO NOTHING`,
    [turn.requestId, turn.tenantId, turn.turnId, turn.actorId, hash, this.cipher.encrypt(turn.requestId, snapshot), new Date(snapshot.deadlineAt), new Date(snapshot.deadlineAt + RETENTION_MS)]);
    const job = await this.get(turn.requestId);
    if (!job || job.tenantId !== turn.tenantId || job.requestHash !== hash) throw new Error("The job identity was reused with different input.");
    return job;
  }
  async get(id: string): Promise<StoredOmniJob | null> {
    assertId(id);
    const result = await this.query("SELECT * FROM control_plane.omni_runtime_jobs WHERE job_id=$1 AND expires_at > clock_timestamp()", [id]);
    return result.rows[0] ? this.decode(result.rows[0]) : null;
  }
  async claim(id: string, owner: string): Promise<StoredOmniJob | null> {
    assertId(id);
    const result = await this.query(`UPDATE control_plane.omni_runtime_jobs SET lease_owner=$2,
      lease_until=clock_timestamp() + interval '90 seconds', revision=revision+1, updated_at=clock_timestamp()
      WHERE job_id=$1 AND status IN ('queued','running') AND expires_at>clock_timestamp()
        AND (lease_owner IS NULL OR lease_until<clock_timestamp() OR lease_owner=$2) RETURNING *`, [id, owner]);
    return result.rows[0] ? this.decode(result.rows[0]) : null;
  }
  async save(job: StoredOmniJob, snapshot: OmniJobSnapshot): Promise<number> {
    const status = snapshot.result ? "complete" : snapshot.failure ? "failed" : snapshot.checkpoint ? "running" : "queued";
    const result = await this.query(`UPDATE control_plane.omni_runtime_jobs SET snapshot=$5, status=$6,
      revision=revision+1, updated_at=clock_timestamp(), lease_until=clock_timestamp() + interval '90 seconds'
      WHERE job_id=$1 AND tenant_id=$2 AND lease_owner=$3 AND revision=$4 RETURNING revision`,
    [job.id, job.tenantId, job.owner, job.revision, this.cipher.encrypt(job.id, snapshot), status]);
    if (!result.rows[0]) throw new Error("The durable job lease was lost; this worker may not publish more results.");
    return Number(result.rows[0].revision);
  }
  async renew(id: string, owner: string): Promise<boolean> {
    const result = await this.query("UPDATE control_plane.omni_runtime_jobs SET lease_until=clock_timestamp() + interval '90 seconds' WHERE job_id=$1 AND lease_owner=$2 AND status IN ('queued','running')", [id, owner]);
    return result.rowCount === 1;
  }
  async release(id: string, owner: string): Promise<void> {
    await this.query("UPDATE control_plane.omni_runtime_jobs SET lease_until=clock_timestamp() WHERE job_id=$1 AND lease_owner=$2", [id, owner]);
  }
  async close() { await this.pool.end(); }
}

/** Local development uses SQLite WAL, with the same encryption and fencing as production. */
export class FileOmniJobStore implements OmniJobStore {
  private readonly cipher: JobCipher;
  private readonly database: DatabaseSync;
  constructor(directory: string, secret: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "jobs.sqlite");
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        encrypted BLOB NOT NULL, terminal INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
      );`);
    this.database.prepare("DELETE FROM jobs WHERE expires_at < ?").run(Date.now());
    this.cipher = new JobCipher(secret);
  }
  private decode(row: Record<string, unknown>): StoredOmniJob {
    const id = String(row.id);
    const snapshot = this.cipher.decrypt(id, Buffer.from(row.encrypted as Uint8Array));
    if (snapshot.turn.tenantId !== row.tenant_id || omniRequestHash(snapshot.turn) !== row.request_hash) throw new Error("The encrypted job does not match its tenant and request identity.");
    return {
      id, tenantId: String(row.tenant_id), requestHash: String(row.request_hash),
      revision: Number(row.revision), owner: row.owner ? String(row.owner) : null,
      leaseUntil: Number(row.lease_until), snapshot,
    };
  }
  async create(snapshot: OmniJobSnapshot): Promise<StoredOmniJob> {
    const { turn } = snapshot;
    assertId(turn.requestId);
    this.database.prepare("INSERT OR IGNORE INTO jobs(id,tenant_id,request_hash,encrypted,expires_at) VALUES(?,?,?,?,?)")
      .run(turn.requestId, turn.tenantId, omniRequestHash(turn), this.cipher.encrypt(turn.requestId, snapshot), snapshot.deadlineAt + RETENTION_MS);
    const job = await this.get(turn.requestId);
    if (!job || job.tenantId !== turn.tenantId || job.requestHash !== omniRequestHash(turn)) throw new Error("The job identity was reused with different input.");
    return job;
  }
  async get(id: string): Promise<StoredOmniJob | null> {
    assertId(id);
    const row = this.database.prepare("SELECT * FROM jobs WHERE id=? AND expires_at>?").get(id, Date.now());
    return row ? this.decode(row) : null;
  }
  async claim(id: string, owner: string): Promise<StoredOmniJob | null> {
    assertId(id);
    const row = this.database.prepare(`UPDATE jobs SET owner=?,lease_until=?,revision=revision+1
      WHERE id=? AND terminal=0 AND expires_at>? AND (owner IS NULL OR owner=? OR lease_until<?) RETURNING *`)
      .get(owner, Date.now() + LEASE_MS, id, Date.now(), owner, Date.now());
    return row ? this.decode(row) : null;
  }
  async save(job: StoredOmniJob, snapshot: OmniJobSnapshot): Promise<number> {
    const row = this.database.prepare(`UPDATE jobs SET encrypted=?,terminal=?,lease_until=?,revision=revision+1
      WHERE id=? AND tenant_id=? AND owner=? AND revision=? RETURNING revision`)
      .get(this.cipher.encrypt(job.id, snapshot), snapshot.result || snapshot.failure ? 1 : 0, Date.now() + LEASE_MS, job.id, job.tenantId, job.owner, job.revision);
    if (!row) throw new Error("The durable job lease was lost.");
    return Number(row.revision);
  }
  async renew(id: string, owner: string): Promise<boolean> {
    return this.database.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND owner=? AND terminal=0")
      .run(Date.now() + LEASE_MS, id, owner).changes === 1;
  }
  async release(id: string, owner: string): Promise<void> {
    this.database.prepare("UPDATE jobs SET lease_until=0 WHERE id=? AND owner=?").run(id, owner);
  }
  async close() { this.database.close(); }
}
