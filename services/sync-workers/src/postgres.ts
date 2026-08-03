import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";

export type PostgresPoolOptions = Readonly<{
  applicationName: string;
  assumedRole?: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
}>;

function poolConfig(connectionString: string, options: PostgresPoolOptions): PoolConfig {
  return {
    connectionString,
    application_name: options.applicationName,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    ...(options.statementTimeoutMs
      ? { statement_timeout: options.statementTimeoutMs }
      : {}),
    allowExitOnIdle: false,
  };
}

class PgQueryClient implements PostgresQueryClient {
  constructor(private readonly client: Pool | PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    const result = await this.client.query<Row & QueryResultRow>(sql, [...values]);
    return { rows: result.rows };
  }
}

/** A small, explicit adapter so business code never depends directly on pg. */
export class PgTransactionalDatabase implements TransactionalPostgres {
  private readonly pool: Pool;
  private readonly assumedRoleSql: string | null;

  constructor(connectionString: string, options: PostgresPoolOptions) {
    this.pool = new Pool(poolConfig(connectionString, options));
    if (options.assumedRole && !/^[a-z_][a-z0-9_]{0,62}$/.test(options.assumedRole)) {
      throw new Error("PostgreSQL assumed role is invalid.");
    }
    this.assumedRoleSql = options.assumedRole
      ? `set local role "${options.assumedRole}"`
      : null;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    return this.transaction((client) => client.query<Row>(sql, values));
  }

  async transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (this.assumedRoleSql) await client.query(this.assumedRoleSql);
      const value = await work(new PgQueryClient(client));
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
