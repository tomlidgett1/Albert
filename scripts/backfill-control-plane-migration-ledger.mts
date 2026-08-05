// Control-plane migration ledger repair.
//
// `npm run migrate` refuses to start when an already-applied migration's
// checksum no longer matches the file (historical rewrite) or when the
// applied prefix has holes. This script repairs those cases deliberately.
//
// Current jobs:
// 1. Resync 0007 after the quarantine_items SELECT grant rewrite.
// 2. Apply any still-missing later migrations (0081 today).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { controlPlaneMigrationBody } from "./control-plane-auth-compat.js";

type Repair = Readonly<{
  id: string;
  mode: "execute" | "record-only" | "resync-checksum";
  // Optional SQL to apply before updating a drifted checksum.
  patchSql?: string;
  // Proves a record-only migration's effect is already installed.
  assertion?: Readonly<{ sql: string; description: string }>;
}>;

const REPAIRS: readonly Repair[] = Object.freeze([
  Object.freeze({
    id: "0007_runtime_service_isolation.sql",
    mode: "resync-checksum",
    // Keep the live ACL aligned with the rewritten migration body.
    patchSql: `
      GRANT SELECT, INSERT ON TABLE control_plane.quarantine_items TO albert_sync_control;
      GRANT INSERT ON TABLE control_plane.audit_log TO albert_sync_control;
    `,
  }),
  Object.freeze({
    id: "0072_m2_sync_connection_generation_fence.sql",
    mode: "record-only",
    assertion: Object.freeze({
      description: "control_plane.assert_sync_connection_generation_fence(text,text,bigint)",
      sql: `SELECT to_regprocedure(
              'control_plane.assert_sync_connection_generation_fence(text,text,bigint)'
            ) IS NOT NULL AS installed`,
    }),
  }),
  Object.freeze({
    id: "0073_m2_defer_incremental_during_backfill.sql",
    mode: "record-only",
    assertion: Object.freeze({
      description: "enqueue_due_incremental_syncs backfill deferral",
      sql: `SELECT position('backfill_complete' in pg_get_functiondef(p.oid))>0 AS installed
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='control_plane' AND p.proname='enqueue_due_incremental_syncs'`,
    }),
  }),
  Object.freeze({ id: "0074_m6_directory_answer_finalization.sql", mode: "execute" }),
  Object.freeze({ id: "0080_m2_fenced_sync_page_run_completion.sql", mode: "execute" }),
  Object.freeze({ id: "0081_m2_optional_initial_backfill_on_oauth_completion.sql", mode: "execute" }),
]);

const databaseUrl = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("CONTROL_PLANE_DATABASE_URL is required.");

const client = new Client({
  connectionString: databaseUrl,
  application_name: "albert-migration-ledger-repair",
  connectionTimeoutMillis: 10_000,
});
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
    "albert:migrations:control-plane",
  ]);
  await client.query('SET ROLE "albert_control_migration_owner"');
  const identity = await client.query<{ current_user: string; session_user: string }>(
    "SELECT current_user, session_user",
  );
  if (identity.rows[0]?.current_user !== "albert_control_migration_owner"
    || identity.rows[0]?.session_user !== "albert_control_deployer") {
    throw new Error("Dedicated control-plane migration identity was not established.");
  }

  for (const repair of REPAIRS) {
    const sql = await readFile(resolve("infra/migrations/control-plane", repair.id), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ checksum_sha256: string }>(
      `SELECT checksum_sha256 FROM albert_migrations.applied_migration
        WHERE stream='control-plane' AND migration_id=$1`,
      [repair.id],
    );

    if (repair.mode === "resync-checksum") {
      if (!existing.rowCount) {
        throw new Error(`${repair.id} must already be applied before checksum resync.`);
      }
      if (existing.rows[0]?.checksum_sha256 === checksum) {
        process.stdout.write(`skipped control-plane/${repair.id} (checksum current)\n`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
        if (repair.patchSql) await client.query(repair.patchSql);
        await client.query(
          `UPDATE albert_migrations.applied_migration
              SET checksum_sha256 = $2
            WHERE stream = 'control-plane' AND migration_id = $1`,
          [repair.id, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      process.stdout.write(`resynced control-plane/${repair.id}\n`);
      continue;
    }

    if (existing.rowCount) {
      process.stdout.write(`skipped control-plane/${repair.id}\n`);
      continue;
    }

    const transaction = /^(?:\s*--[^\n]*\n)*\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/iu.exec(sql);
    if (!transaction) throw new Error(`${repair.id} must contain one explicit outer BEGIN/COMMIT transaction.`);

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
      if (repair.mode === "execute") {
        await client.query(controlPlaneMigrationBody({ id: repair.id, checksum, body: transaction[1]! }));
      } else {
        const proof = await client.query<{ installed: boolean }>(repair.assertion!.sql);
        if (proof.rows[0]?.installed !== true) {
          throw new Error(
            `${repair.id} is recorded as already applied but ${repair.assertion!.description} is not installed.`,
          );
        }
      }
      await client.query(
        `INSERT INTO albert_migrations.applied_migration (
           stream, migration_id, checksum_sha256, applied_by
         ) VALUES ('control-plane', $1, $2, 'albert_control_migration_owner')`,
        [repair.id, checksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    process.stdout.write(`${repair.mode === "execute" ? "applied" : "recorded"} control-plane/${repair.id}\n`);
  }
} finally {
  await client.query("RESET ROLE").catch(() => undefined);
  await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
    "albert:migrations:control-plane",
  ]).catch(() => undefined);
  await client.end();
}
