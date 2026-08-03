import {
  operatorDiagnosticGrantSchema,
  operatorDiagnosticSampleSchema,
  protectedDogfoodOnboardingReceiptRequestSchema,
  protectedDogfoodOnboardingReceiptSchema,
  targetMatchesStage,
  type OperatorDiagnosticGrant,
  type OperatorDiagnosticSample,
  type ProtectedDogfoodOnboardingReceipt,
  type ProtectedDogfoodOnboardingReceiptRequest,
} from "./contracts.js";

type Row = Readonly<Record<string, unknown>>;

export interface DiagnosticPgClient {
  query(sql: string, parameters?: readonly unknown[]): Promise<Readonly<{ rows: readonly Row[] }>>;
  release(): void;
}

export interface DiagnosticPgPool {
  connect(): Promise<DiagnosticPgClient>;
  end?(): Promise<void>;
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SENSITIVE_COLUMN = /(?:^|_)(?:access|refresh|oauth|auth|authorization|bearer|token|secret|password|passcode|credential|private_key|api_key|cookie|headers?)(?:_|$)/u;
const EXCLUDED_TYPES = new Set(["json", "jsonb", "bytea"]);
const MAX_COLUMNS = 32;
const CELL_CHARACTER_LIMIT = 500;

function identifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error("Diagnostic target contains an unsafe identifier.");
  return `"${value}"`;
}

function databaseErrorCode(error: unknown): string {
  const candidate = error as Readonly<{ code?: unknown }>;
  return typeof candidate?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(candidate.code)
    ? candidate.code
    : "DIAGNOSTIC_QUERY_FAILED";
}

export class PostgresOperatorDiagnosticControlStore {
  constructor(private readonly pool: DiagnosticPgPool) {}

  async claim(revealId: string): Promise<OperatorDiagnosticGrant> {
    return this.inRole(async (client) => {
      const result = await client.query(
        "SELECT control_plane.claim_operator_diagnostic_reveal($1) AS grant",
        [revealId],
      );
      return operatorDiagnosticGrantSchema.parse(result.rows[0]?.grant);
    });
  }

  async complete(input: Readonly<{
    revealId: string;
    status: "completed" | "failed";
    rowCount: number;
    errorCode?: string;
  }>): Promise<void> {
    await this.inRole(async (client) => {
      await client.query(
        "SELECT control_plane.complete_operator_diagnostic_reveal($1,$2,$3,$4)",
        [input.revealId, input.status, input.rowCount, input.errorCode ?? null],
      );
    });
  }

  async completeOnboardingReceipt(
    untrustedInput: ProtectedDogfoodOnboardingReceiptRequest,
  ): Promise<ProtectedDogfoodOnboardingReceipt> {
    const input = protectedDogfoodOnboardingReceiptRequestSchema.parse(untrustedInput);
    return this.inRole(async (client) => {
      const result = await client.query(
        `SELECT control_plane.complete_protected_dogfood_onboarding_receipt(
           $1::text,$2::uuid,$3::text,$4::text,$5::text
         ) AS receipt`,
        [
          input.journeyId,
          input.userId,
          input.tenantId,
          input.browserNonceHash,
          input.userAgentHash,
        ],
      );
      return protectedDogfoodOnboardingReceiptSchema.parse(result.rows[0]?.receipt);
    });
  }

  async ready(): Promise<boolean> {
    try {
      return await this.inRole(async (client) => {
        const result = await client.query(
          `SELECT control_plane.assert_operator_diagnostic_control_ready()
               AND control_plane.assert_analytical_capability_issuer_ready() AS ready`,
        );
        return result.rows[0]?.ready === true;
      });
    } catch {
      return false;
    }
  }

  private async inRole<T>(operation: (client: DiagnosticPgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
      await client.query("SELECT set_config('statement_timeout','2000ms',true)");
      await client.query("SELECT control_plane.assert_operator_diagnostic_control_ready()");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresOperatorDiagnosticReadStore {
  constructor(private readonly pool: DiagnosticPgPool) {}

  async sample(untrustedGrant: OperatorDiagnosticGrant): Promise<OperatorDiagnosticSample> {
    const grant = operatorDiagnosticGrantSchema.parse(untrustedGrant);
    if (!targetMatchesStage(grant)) throw new Error("Diagnostic grant stage does not match its target schema.");
    const schemaName = identifier(grant.schema_name);
    const tableName = identifier(grant.table_name);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertRuntimeIdentity(client);
      await client.query("SET LOCAL ROLE diagnostic_ro");
      await client.query(
        "SELECT set_config('albert.tenant_capability',$1,true)",
        [grant.analytical_capability],
      );
      await client.query("SELECT set_config('statement_timeout','2000ms',true)");
      await client.query("SELECT set_config('lock_timeout','500ms',true)");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [grant.tenant_id],
      );
      const metadata = await client.query(
        `SELECT column_name,data_type
           FROM information_schema.columns
          WHERE table_schema=$1 AND table_name=$2
          ORDER BY ordinal_position`,
        [grant.schema_name, grant.table_name],
      );
      const tenantColumn = metadata.rows.some((row) => row.column_name === "tenant_id");
      if (!tenantColumn) throw new Error("Diagnostic target is not tenant scoped.");
      const candidates = metadata.rows.filter((row) => {
        const column = typeof row.column_name === "string" ? row.column_name : "";
        const dataType = typeof row.data_type === "string" ? row.data_type : "";
        return column !== "tenant_id" && SAFE_IDENTIFIER.test(column) &&
          !SENSITIVE_COLUMN.test(column) && !EXCLUDED_TYPES.has(dataType);
      });
      const selected = candidates.slice(0, MAX_COLUMNS).map((row) => String(row.column_name));
      if (!selected.length) throw new Error("Diagnostic target has no reveal-safe scalar columns.");
      const projection = selected.map((column) => {
        const quoted = identifier(column);
        return `CASE WHEN ${quoted} IS NULL THEN NULL ELSE left(${quoted}::text,${CELL_CHARACTER_LIMIT}) END AS ${quoted}`;
      }).join(",");
      // Identifiers come exclusively from the one-use pipeline_stats grant and
      // information_schema, then pass the strict identifier grammar above.
      // Tenant and limit remain ordinary query parameters.
      const result = await client.query(
        `SELECT ${projection} FROM ${schemaName}.${tableName} WHERE tenant_id=$1 LIMIT $2`,
        [grant.tenant_id, grant.row_limit],
      );
      await client.query("COMMIT");
      const rows = result.rows.map((row) => Object.fromEntries(selected.map((column) => {
        const value = row[column];
        return [column, value === null || value === undefined ? null : String(value)];
      })));
      return operatorDiagnosticSampleSchema.parse({
        revealId: grant.reveal_id,
        stage: grant.pipeline_stage,
        schemaName: grant.schema_name,
        tableName: grant.table_name,
        columns: selected,
        rows,
        rowCount: rows.length,
        excludedColumnCount: metadata.rows.length - 1 - selected.length,
        cellCharacterLimit: CELL_CHARACTER_LIMIT,
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original failure */ }
      const wrapped = new Error("Diagnostic query failed.");
      Object.assign(wrapped, { diagnosticCode: databaseErrorCode(error) });
      throw wrapped;
    } finally {
      client.release();
    }
  }

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await this.assertRuntimeIdentity(client);
      await client.query("SET LOCAL ROLE diagnostic_ro");
      const result = await client.query(
        `SELECT current_role='diagnostic_ro'
             AND capability_internal.assert_verifier_ready() AS ready`,
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

  private async assertRuntimeIdentity(client: DiagnosticPgClient): Promise<void> {
    const result = await client.query(
      `SELECT session_user='albert_operator_diagnostic_analytical_runtime'
          AND pg_catalog.pg_has_role(session_user,'diagnostic_ro','member')
          AND (SELECT count(*) FROM pg_catalog.pg_auth_members membership
               JOIN pg_catalog.pg_roles member ON member.oid=membership.member
               WHERE member.rolname=session_user)=1 AS ready`,
    );
    if (result.rows[0]?.ready !== true) {
      throw new Error("Operator diagnostic analytical login has an unsafe role boundary.");
    }
  }
}
