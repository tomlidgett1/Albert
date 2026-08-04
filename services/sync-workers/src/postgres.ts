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
  onPoolAcquire?: (elapsedMs: number) => void;
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
  private readonly onPoolAcquire: ((elapsedMs: number) => void) | undefined;

  constructor(connectionString: string, options: PostgresPoolOptions) {
    this.pool = new Pool(poolConfig(connectionString, options));
    // A backend terminated by the server (timeout, failover) surfaces as an
    // 'error' event on an idle pooled client. Without a listener Node treats
    // it as an unhandled 'error' event and exits the whole process.
    this.pool.on("error", () => undefined);
    this.onPoolAcquire = options.onPoolAcquire;
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
    const acquireStartedAt = performance.now();
    const client = await this.pool.connect();
    this.onPoolAcquire?.(performance.now() - acquireStartedAt);
    // While checked out, a server-terminated connection (for example an
    // idle-in-transaction timeout) emits 'error' with no query in flight.
    // Capture it so the next query rejects and the transaction fails,
    // instead of the process crashing on an unhandled 'error' event.
    let connectionError: Error | undefined;
    const onClientError = (error: Error) => {
      connectionError = error;
    };
    client.on("error", onClientError);
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
      client.off("error", onClientError);
      // Passing the error destroys the dead connection instead of returning
      // it to the pool.
      client.release(connectionError);
    }
  }

  async ping(): Promise<void> {
    await this.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
