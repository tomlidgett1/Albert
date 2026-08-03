import type { DatabaseResult, SemanticReadDatabase } from "./types.js";

export interface PgClientLike {
  query(sql: string, parameters?: readonly unknown[]): Promise<Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>>;
  release(): void;
}
export interface PgPoolLike { connect(): Promise<PgClientLike>; }

/** PostgreSQL adapter that makes the semantic_ro boundary executable and testable. */
export class PostgresSemanticReadDatabase implements SemanticReadDatabase {
  constructor(private readonly pool: PgPoolLike, private readonly clock: () => number = Date.now) {}

  async queryAsSemanticRole(request: Readonly<{
    tenantId: string;
    sql: string;
    parameters: readonly unknown[];
    statementTimeoutMs: number;
    expectedIdentityGraph?: Readonly<{ version: number; hash: string }>;
  }>): Promise<DatabaseResult> {
    if (request.parameters[0] !== request.tenantId) throw new Error("Compiled query tenant parameter does not match trusted context.");
    if (request.expectedIdentityGraph && (
      !Number.isSafeInteger(request.expectedIdentityGraph.version)
      || request.expectedIdentityGraph.version < 0
      || !/^[a-f0-9]{32}$/.test(request.expectedIdentityGraph.hash)
    )) throw new Error("Expected identity graph state is invalid.");
    const client = await this.pool.connect();
    const startedAt = this.clock();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL ROLE semantic_ro");
      await client.query("SELECT set_config('albert.tenant_id', $1, true)", [request.tenantId]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${request.statementTimeoutMs}ms`]);
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [request.tenantId],
      );
      if (request.expectedIdentityGraph) {
        const state = await client.query(
          `SELECT version::text AS version,graph_hash
           FROM semantic_internal.identity_graph_state
           WHERE tenant_id=$1`,
          [request.tenantId],
        );
        const row = state.rows[0];
        const actualVersion = row ? Number(row.version) : 0;
        const actualHash = row && typeof row.graph_hash === "string"
          ? row.graph_hash
          : "d41d8cd98f00b204e9800998ecf8427e";
        if (
          actualVersion !== request.expectedIdentityGraph.version
          || actualHash !== request.expectedIdentityGraph.hash
        ) {
          throw new IdentityGraphChangedError();
        }
      }
      const result = await client.query(request.sql, request.parameters);
      await client.query("COMMIT");
      return { rows: result.rows, durationMs: Math.max(0, this.clock() - startedAt) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export class IdentityGraphChangedError extends Error {
  readonly code = "IDENTITY_GRAPH_CHANGED";
  constructor() {
    super("Identity graph changed before the governed query began; reload semantic context and retry.");
    this.name = "IdentityGraphChangedError";
  }
}
