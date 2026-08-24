import type { TransactionalPostgres } from "./database.js";

export type FivetranDestinationBinding = Readonly<{
  destinationSchema: string;
  tenantId: string;
  connectionId: string;
  writerRole?: string;
}>;

export type FivetranDestinationTable = Readonly<{ table: string; rows: number }>;

export class FivetranDestinationStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async bind(input: FivetranDestinationBinding): Promise<void> {
    await this.db.query(
      `select ingestion.register_fivetran_destination($1, $2, $3, $4)`,
      [input.destinationSchema, input.tenantId, input.connectionId, input.writerRole ?? null],
    );
  }

  /**
   * What Fivetran has actually landed in the tenant's schema. Read from the
   * catalog + planner statistics rather than `count(*)` so a poll never scans
   * a large table; `n_live_tup` is maintained incrementally on insert/delete,
   * which is close enough for a progress readout (the UI labels it "≈").
   * Fivetran's own bookkeeping tables (`fivetran_audit`, `_fivetran_*`) are
   * excluded so the count reflects Xero data only.
   */
  async inventory(input: Readonly<{ destinationSchema: string }>): Promise<readonly FivetranDestinationTable[]> {
    if (!/^[a-z][a-z0-9_]{0,127}$/u.test(input.destinationSchema)) return [];
    const result = await this.db.query<{ table_name: string; live_rows: string | number | null }>(
      `select cls.relname as table_name,
              coalesce(stat.n_live_tup, 0) as live_rows
         from pg_catalog.pg_class as cls
         join pg_catalog.pg_namespace as nsp on nsp.oid = cls.relnamespace
         left join pg_catalog.pg_stat_all_tables as stat on stat.relid = cls.oid
        where nsp.nspname = $1
          and cls.relkind in ('r', 'p')
          and cls.relname not like 'fivetran\\_%'
          and cls.relname not like '\\_fivetran\\_%'
        order by cls.relname
        limit 400`,
      [input.destinationSchema],
    );
    return result.rows.map((row) => ({
      table: row.table_name,
      rows: Math.max(0, Number(row.live_rows ?? 0) || 0),
    }));
  }

  /**
   * Rebuild the per-source union views (source_<prefix>_fivetran.*) over every
   * active bound schema so the Cube contract sees a new tenant's tables.
   */
  async rebuildSourceViews(prefix: string): Promise<number> {
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(prefix)) return 0;
    const result = await this.db.query<{ rebuild_fivetran_source_views: number }>(
      `select ingestion.rebuild_fivetran_source_views($1) as rebuild_fivetran_source_views`,
      [prefix],
    );
    if (prefix === "stripe") {
      await this.db.query(`select ingestion.rebuild_stripe_official_views()`);
    }
    return Number(result.rows[0]?.rebuild_fivetran_source_views ?? 0);
  }

  /** Drop a disconnected connection's schema out of the union views (before its purge). */
  async retire(input: Readonly<{ destinationSchema: string; tenantId: string }>): Promise<void> {
    await this.db.query(
      `select ingestion.retire_fivetran_destination($1, $2)`,
      [input.destinationSchema, input.tenantId],
    );
  }

  /**
   * Erase a retired destination schema (DROP ... CASCADE). The definer refuses
   * unless the binding is already retired, so this can never race a live sync.
   */
  async purge(input: Readonly<{ destinationSchema: string; tenantId: string }>): Promise<void> {
    await this.db.query(
      `select ingestion.purge_fivetran_destination($1, $2)`,
      [input.destinationSchema, input.tenantId],
    );
  }

  async stamp(input: Readonly<{
    destinationSchema: string;
    tenantId: string;
  }>): Promise<number> {
    const result = await this.db.query<{ stamp_fivetran_destination: number }>(
      `select ingestion.stamp_fivetran_destination($1, $2) as stamp_fivetran_destination`,
      [input.destinationSchema, input.tenantId],
    );
    return Number(result.rows[0]?.stamp_fivetran_destination ?? 0);
  }
}
