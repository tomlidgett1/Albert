import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ANTHROPIC_PRIMARY_MODEL,
  ANTHROPIC_RUNTIME,
  ANTHROPIC_SDK_VERSION,
} from "../../../packages/anthropic-analytics/src/index.js";

export interface PgClientLike {
  query(sql: string, values?: readonly unknown[]): Promise<Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

const sessionRowSchema = z.object({ session_id: z.string().uuid(), created: z.boolean() });
const entryRowSchema = z.object({ entry: z.record(z.string(), z.unknown()) });

function serializedEntry(entry: SessionStoreEntry): Readonly<{ json: string; digest: string }> {
  const json = JSON.stringify(entry);
  return Object.freeze({ json, digest: createHash("sha256").update(json).digest("hex") });
}

export interface AnthropicSessionRepository {
  ensureSession(input: Readonly<{
    tenantId: string;
    actorUserId: string;
    conversationId: string;
    turnId: string;
    model: string;
    promptDigest: string;
    toolsetDigest: string;
  }>): Promise<Readonly<{ sessionId: string; created: boolean }>>;
  append(tenantId: string, key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(tenantId: string, key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSubkeys(tenantId: string, key: { projectKey: string; sessionId: string }): Promise<string[]>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresAnthropicSessionRepository implements AnthropicSessionRepository {
  constructor(private readonly pool: PgPoolLike) {}

  private async transaction<T>(tenantId: string, run: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_anthropic_control");
      await client.query("SELECT set_config('albert.tenant_id',$1,true)", [tenantId]);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureSession(input: Readonly<{
    tenantId: string;
    actorUserId: string;
    conversationId: string;
    turnId: string;
    model: string;
    promptDigest: string;
    toolsetDigest: string;
  }>): Promise<Readonly<{ sessionId: string; created: boolean }>> {
    return this.transaction(input.tenantId, async (client) => {
      const candidate = randomUUID();
      const result = await client.query(
        `SELECT session_id,created
           FROM control_plane.claim_anthropic_conversation_session(
             $1,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9,$10
           )`,
        [
          input.tenantId,
          input.actorUserId,
          input.conversationId,
          input.turnId,
          candidate,
          ANTHROPIC_RUNTIME,
          input.model,
          ANTHROPIC_SDK_VERSION,
          input.promptDigest,
          input.toolsetDigest,
        ],
      );
      const row = sessionRowSchema.parse(result.rows[0]);
      return Object.freeze({ sessionId: row.session_id, created: row.created });
    });
  }

  async append(tenantId: string, key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.transaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`anthropic-session:${tenantId}:${key.sessionId}:${key.subpath ?? ""}`]);
      for (const entry of entries) {
        const serialized = serializedEntry(entry);
        await client.query(
          `INSERT INTO control_plane.anthropic_session_entries(
             tenant_id,session_id,project_key,subpath,entry_uuid,entry_digest,entry
           ) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7::jsonb)
           ON CONFLICT DO NOTHING`,
          [tenantId, key.sessionId, key.projectKey, key.subpath ?? "", typeof entry.uuid === "string" ? entry.uuid : null, serialized.digest, serialized.json],
        );
      }
      await client.query(
        `UPDATE control_plane.anthropic_conversation_sessions
            SET updated_at=now(),expires_at=greatest(expires_at,now()+interval '30 days')
          WHERE tenant_id=$1 AND session_id=$2::uuid`,
        [tenantId, key.sessionId],
      );
    });
  }

  async load(tenantId: string, key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query(
        `SELECT entry
           FROM control_plane.anthropic_session_entries
          WHERE tenant_id=$1 AND session_id=$2::uuid AND project_key=$3 AND subpath=$4
          ORDER BY entry_sequence`,
        [tenantId, key.sessionId, key.projectKey, key.subpath ?? ""],
      );
      if (result.rows.length === 0) return null;
      return result.rows.map((row) => entryRowSchema.parse(row).entry as SessionStoreEntry);
    });
  }

  async listSubkeys(tenantId: string, key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query(
        `SELECT DISTINCT subpath
           FROM control_plane.anthropic_session_entries
          WHERE tenant_id=$1 AND session_id=$2::uuid AND project_key=$3 AND subpath<>''
          ORDER BY subpath`,
        [tenantId, key.sessionId, key.projectKey],
      );
      return result.rows.flatMap((row) => typeof row.subpath === "string" ? [row.subpath] : []);
    });
  }

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL ROLE albert_anthropic_control");
      const result = await client.query("SELECT control_plane.assert_anthropic_session_store_ready() AS ready");
      await client.query("COMMIT");
      return result.rows[0]?.ready === true;
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* readiness is false */ }
      return false;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}

export class TenantPostgresSessionStore implements SessionStore {
  constructor(private readonly repository: AnthropicSessionRepository, private readonly tenantId: string) {}

  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    return this.repository.append(this.tenantId, key, entries);
  }

  load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.repository.load(this.tenantId, key);
  }

  listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.repository.listSubkeys(this.tenantId, key);
  }
}

/** Deterministic repository for contract tests; production never selects it. */
export class InMemoryAnthropicSessionRepository implements AnthropicSessionRepository {
  private readonly sessions = new Map<string, string>();
  private readonly entries = new Map<string, SessionStoreEntry[]>();

  async ensureSession(input: Readonly<{ tenantId: string; actorUserId: string; conversationId: string; turnId: string; model: string; promptDigest: string; toolsetDigest: string }>): Promise<Readonly<{ sessionId: string; created: boolean }>> {
    const key = `${input.tenantId}:${input.conversationId}`;
    const existing = this.sessions.get(key);
    if (existing) return Object.freeze({ sessionId: existing, created: false });
    const created = randomUUID();
    this.sessions.set(key, created);
    return Object.freeze({ sessionId: created, created: true });
  }

  async append(tenantId: string, key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const storageKey = `${tenantId}:${key.sessionId}:${key.projectKey}:${key.subpath ?? ""}`;
    const current = this.entries.get(storageKey) ?? [];
    const identities = new Set(current.map((entry) => typeof entry.uuid === "string" ? `uuid:${entry.uuid}` : `digest:${serializedEntry(entry).digest}`));
    for (const entry of entries) {
      const identity = typeof entry.uuid === "string" ? `uuid:${entry.uuid}` : `digest:${serializedEntry(entry).digest}`;
      if (identities.has(identity)) continue;
      current.push(entry);
      identities.add(identity);
    }
    this.entries.set(storageKey, current);
  }

  async load(tenantId: string, key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.entries.get(`${tenantId}:${key.sessionId}:${key.projectKey}:${key.subpath ?? ""}`) ?? null;
  }

  async listSubkeys(tenantId: string, key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const prefix = `${tenantId}:${key.sessionId}:${key.projectKey}:`;
    return [...this.entries.keys()].filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length)).filter(Boolean);
  }

  async ready(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}

export const ANTHROPIC_SESSION_METADATA = Object.freeze({
  runtime: ANTHROPIC_RUNTIME,
  model: ANTHROPIC_PRIMARY_MODEL,
  sdkVersion: ANTHROPIC_SDK_VERSION,
});
