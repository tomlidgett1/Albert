import type {
  DatabaseResult,
  SemanticCapabilityEvidence,
  SemanticReadDatabase,
} from "./types.js";

export interface PgClientLike {
  query(sql: string, parameters?: readonly unknown[]): Promise<Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>>;
  release(): void;
}
export interface PgPoolLike { connect(): Promise<PgClientLike>; }

export type AnalyticalCapabilityScope = "semantic_read" | "semantic_metadata";

export interface SemanticAnalyticalCapabilityIssuer {
  issue(request: Readonly<{
    tenantId: string;
    scope: AnalyticalCapabilityScope;
    evidence: SemanticCapabilityEvidence;
  }>): Promise<string>;
  ready(): Promise<boolean>;
}

export class PostgresSemanticAnalyticalCapabilityIssuer implements SemanticAnalyticalCapabilityIssuer {
  constructor(private readonly controlPlanePool: PgPoolLike) {}

  async issue(request: Readonly<{
    tenantId: string;
    scope: AnalyticalCapabilityScope;
    evidence: SemanticCapabilityEvidence;
  }>): Promise<string> {
    const client = await this.controlPlanePool.connect();
    try {
      // Must be read/write: issue_semantic_analytical_capability locks the
      // active turn lease with SELECT FOR SHARE, which Postgres rejects in a
      // read-only transaction.
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_semantic_control");
      const result = await client.query(
        `SELECT control_plane.issue_semantic_analytical_capability(
           $1::text,$2::text,$3::text,$4::text
         ) AS capability`,
        [request.tenantId, request.evidence.conversationId, request.evidence.turnId, request.scope],
      );
      const capability = result.rows[0]?.capability;
      if (typeof capability !== "string" || capability.length < 100 || capability.length > 4096) {
        throw new Error("Control plane returned an invalid analytical capability.");
      }
      await client.query("COMMIT");
      return capability;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async ready(): Promise<boolean> {
    const client = await this.controlPlanePool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL ROLE albert_semantic_control");
      const result = await client.query(
        "SELECT control_plane.assert_analytical_capability_issuer_ready() AS ready",
      );
      await client.query("COMMIT");
      return result.rows[0]?.ready === true;
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* readiness is false */ }
      return false;
    } finally {
      client.release();
    }
  }
}

/** PostgreSQL adapter that makes the semantic_ro boundary executable and testable. */
export class PostgresSemanticReadDatabase implements SemanticReadDatabase {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly clock: () => number = Date.now,
    private readonly capabilityIssuer?: SemanticAnalyticalCapabilityIssuer,
  ) {}

  async queryAsSemanticRole(request: Readonly<{
    tenantId: string;
    sql: string;
    parameters: readonly unknown[];
    statementTimeoutMs: number;
    expectedIdentityGraph?: Readonly<{ version: number; hash: string }>;
    capabilityEvidence?: SemanticCapabilityEvidence;
  }>): Promise<DatabaseResult> {
    if (request.parameters[0] !== request.tenantId) throw new Error("Compiled query tenant parameter does not match trusted context.");
    if (request.expectedIdentityGraph && (
      !Number.isSafeInteger(request.expectedIdentityGraph.version)
      || request.expectedIdentityGraph.version < 0
      || !/^[a-f0-9]{32}$/.test(request.expectedIdentityGraph.hash)
    )) throw new Error("Expected identity graph state is invalid.");
    const capability = this.capabilityIssuer
      ? await this.capabilityIssuer.issue({
        tenantId: request.tenantId,
        scope: "semantic_read",
        evidence: requiredCapabilityEvidence(request.capabilityEvidence),
      })
      : undefined;
    const client = await this.pool.connect();
    const startedAt = this.clock();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL ROLE semantic_ro");
      if (capability) {
        await client.query("SELECT set_config('albert.tenant_capability', $1, true)", [capability]);
      } else {
        // Admin-only fixture path. Exact production runtime logins cannot use
        // this legacy setting because core.current_tenant_id verifies tokens.
        await client.query("SELECT set_config('albert.tenant_id', $1, true)", [request.tenantId]);
      }
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

function requiredCapabilityEvidence(
  value: SemanticCapabilityEvidence | undefined,
): SemanticCapabilityEvidence {
  if (!value?.conversationId?.trim() || !value.turnId?.trim()) {
    throw new Error("Semantic analytical access requires a durable conversation-turn lease.");
  }
  return value;
}

export class IdentityGraphChangedError extends Error {
  readonly code = "IDENTITY_GRAPH_CHANGED";
  constructor() {
    super("Identity graph changed before the governed query began; reload semantic context and retry.");
    this.name = "IdentityGraphChangedError";
  }
}

export async function probeAnalyticalCapabilityVerifier(
  pool: PgPoolLike,
  role: "semantic_ro" | "semantic_meta_rw",
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(
      "SELECT capability_internal.assert_verifier_ready() AS ready",
    );
    await client.query("COMMIT");
    return result.rows[0]?.ready === true;
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* readiness is false */ }
    return false;
  } finally {
    client.release();
  }
}
