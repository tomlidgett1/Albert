import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migrationRoots = [
  { stream: "control-plane", url: new URL("infra/migrations/control-plane/", root) },
  { stream: "analytical", url: new URL("infra/migrations/analytical/", root) },
] as const;

type StatusContract = Readonly<{
  table: string;
  lookup: string;
  lookupColumn: "status" | "value";
  foreignKey: string;
  legacyCheck: string;
  statuses: readonly string[];
}>;

type CreatedStatusContract = Readonly<{
  table: string;
  lookup: string;
  statuses: readonly string[];
}>;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertLookupBackedStatus(sql: string, contract: StatusContract): void {
  const table = escaped(contract.table);
  const lookup = escaped(contract.lookup);
  const foreignKey = escaped(contract.foreignKey);
  const legacyCheck = escaped(contract.legacyCheck);

  const addAt = sql.search(new RegExp(
    `ALTER TABLE ${table}\\s+ADD CONSTRAINT ${foreignKey}\\s+` +
      `FOREIGN KEY \\(status\\)\\s+REFERENCES ${lookup}\\(${contract.lookupColumn}\\)\\s+` +
      "NOT VALID",
    "iu",
  ));
  const validateAt = sql.search(new RegExp(
    `ALTER TABLE ${table}\\s+VALIDATE CONSTRAINT ${foreignKey}`,
    "iu",
  ));
  const dropAt = sql.search(new RegExp(
    `ALTER TABLE ${table}\\s+DROP CONSTRAINT IF EXISTS ${legacyCheck}`,
    "iu",
  ));

  assert.ok(addAt >= 0, `${contract.table} must add its lookup foreign key without a blocking validation scan`);
  assert.ok(validateAt > addAt, `${contract.table} must validate its lookup foreign key`);
  assert.ok(dropAt > validateAt, `${contract.table} must retain its literal check until the foreign key validates`);
  for (const status of contract.statuses) {
    assert.match(sql, new RegExp(`\\('${escaped(status)}'\\s*,`, "u"));
  }
}

function assertCreatedLookupBackedStatus(
  sql: string,
  contract: CreatedStatusContract,
): void {
  const table = escaped(contract.table);
  const lookup = escaped(contract.lookup);

  assert.match(
    sql,
    new RegExp(
      `CREATE TABLE ${lookup}\\s*\\(\\s*` +
        "status text PRIMARY KEY,\\s*description text NOT NULL",
      "iu",
    ),
    `${contract.lookup} must be a described, reviewed vocabulary`,
  );
  assert.match(
    sql,
    new RegExp(
      `CREATE TABLE ${table}\\s*\\([\\s\\S]*?` +
        `status text NOT NULL\\s+REFERENCES ${lookup}\\(status\\)`,
      "iu",
    ),
    `${contract.table}.status must reference its dedicated lookup`,
  );
  assert.match(
    sql,
    new RegExp(`REVOKE ALL ON TABLE[\\s\\S]*?${lookup}`, "iu"),
    `${contract.lookup} must not be exposed to application roles`,
  );
  for (const status of contract.statuses) {
    assert.match(sql, new RegExp(`\\('${escaped(status)}'\\s*,`, "u"));
  }
}

test("the migration history contains no unreviewed literal-only lifecycle vocabulary", async () => {
  const literalStatusChecks: string[] = [];
  for (const migrationRoot of migrationRoots) {
    const filenames = (await readdir(migrationRoot.url))
      .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(filename))
      .sort();
    for (const filename of filenames) {
      const sql = await readFile(new URL(filename, migrationRoot.url), "utf8");
      const declarations = sql.match(
        /\bstatus\s+text\b[\s\S]{0,160}?\bCHECK\s*\(\s*status\s+IN\s*\(/giu,
      ) ?? [];
      for (let index = 0; index < declarations.length; index += 1) {
        literalStatusChecks.push(`${migrationRoot.stream}/${filename}`);
      }
    }
  }

  // These historical declarations are retained only because migrations are
  // immutable. 0061/0101 replace the lifecycle vocabularies in the final
  // schema; 0067's two-minute, one-use challenge state is deliberately local
  // to the protected attestation boundary. A new declaration must not expand
  // this reviewed baseline.
  assert.deepEqual(literalStatusChecks, [
    "control-plane/0013_m7_identity_decision_projection.sql",
    "control-plane/0030_m2_operator_diagnostic_reveals.sql",
    "control-plane/0033_m2_durable_reconciliation_sweeps.sql",
    "control-plane/0045_m2_progressive_dependency_barriers.sql",
    "control-plane/0053_m8_user_bound_tenant_deletion_receipts.sql",
    "control-plane/0067_m7_independent_live_vendor_attestation.sql",
    "control-plane/0145_m1_fivetran_xero_connections.sql",
    "control-plane/0153_m8_business_context.sql",
    "control-plane/0154_m6_fivetran_my_data_browser.sql",
    "control-plane/0158_m6_proactive_control_panel.sql",
    "control-plane/0158_m6_proactive_control_panel.sql",
    "control-plane/0161_m8_semantic_memory.sql",
    "control-plane/0168_m8_codex_swarm.sql",
    "control-plane/0168_m8_codex_swarm.sql",
    // 0178 reuses the reviewed run-lifecycle vocabulary of 0158/0168
    // (running/completed/failed/abandoned) for the daily dashboard session.
    "control-plane/0178_m6_dashboard_master.sql",
    // 0183 declared the scheduled-run lifecycle (queued/running/sent/failed/
    // missed) literally; 0184 moves it to a described lookup (asserted below).
    "control-plane/0183_m8_scheduled_tasks.sql",
    "analytical/0081_m2_reconciliation_and_connector_stream_health.sql",
  ]);
});

test("control-plane lifecycle statuses are lookup-backed without changing existing rows", async () => {
  const sql = await readFile(new URL(
    "infra/migrations/control-plane/0061_m0_lookup_backed_lifecycle_statuses.sql",
    root,
  ), "utf8");

  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/u);
  assert.doesNotMatch(sql, /CREATE\s+TYPE[\s\S]*AS\s+ENUM/iu);

  const contracts: readonly StatusContract[] = [
    {
      table: "control_plane.identity_decision_projection_outbox",
      lookup: "control_plane.identity_decision_projection_status_lookup",
      lookupColumn: "status",
      foreignKey: "identity_decision_projection_outbox_status_fkey",
      legacyCheck: "identity_decision_projection_outbox_status_check",
      statuses: ["queued", "running", "retry_wait", "succeeded", "failed"],
    },
    {
      table: "control_plane.operator_diagnostic_reveal_outcomes",
      lookup: "control_plane.operator_diagnostic_reveal_outcome_status_lookup",
      lookupColumn: "status",
      foreignKey: "operator_diagnostic_reveal_outcomes_status_fkey",
      legacyCheck: "operator_diagnostic_reveal_outcomes_status_check",
      statuses: ["completed", "failed"],
    },
    {
      table: "control_plane.reconciliation_stream_sweeps",
      lookup: "control_plane.reconciliation_stream_sweep_status_lookup",
      lookupColumn: "status",
      foreignKey: "reconciliation_stream_sweeps_status_fkey",
      legacyCheck: "reconciliation_stream_sweeps_status_check",
      statuses: ["planned", "running", "complete", "blocked"],
    },
    {
      table: "control_plane.progressive_stream_coverage",
      lookup: "control_plane.progressive_stream_coverage_status_lookup",
      lookupColumn: "status",
      foreignKey: "progressive_stream_coverage_status_fkey",
      legacyCheck: "progressive_stream_coverage_status_check",
      statuses: ["pending", "queryable", "degraded", "superseded"],
    },
    {
      table: "control_plane.tenant_deletion_receipts",
      lookup: "control_plane.deletion_request_status_lookup",
      lookupColumn: "status",
      foreignKey: "tenant_deletion_receipts_status_fkey",
      legacyCheck: "tenant_deletion_receipts_status_check",
      statuses: [],
    },
  ];

  for (const contract of contracts) assertLookupBackedStatus(sql, contract);

  assert.doesNotMatch(
    sql,
    /CREATE TABLE IF NOT EXISTS control_plane\.deletion_request_status_lookup/iu,
    "the receipt must reuse the deletion request lifecycle rather than duplicate it",
  );
});

test("scheduled-run lifecycle moves to a described lookup without changing existing rows", async () => {
  const sql = await readFile(new URL(
    "infra/migrations/control-plane/0184_m8_scheduled_run_status_lookup.sql",
    root,
  ), "utf8");

  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/u);
  assert.doesNotMatch(sql, /CREATE\s+TYPE[\s\S]*AS\s+ENUM/iu);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS control_plane\.scheduled_run_status_lookup \(\s*status text PRIMARY KEY,\s*description text NOT NULL/u,
    "the scheduled-run vocabulary must be described",
  );
  assert.match(sql, /REVOKE ALL ON TABLE control_plane\.scheduled_run_status_lookup FROM authenticated/u);
  assertLookupBackedStatus(sql, {
    table: "control_plane.scheduled_task_runs",
    lookup: "control_plane.scheduled_run_status_lookup",
    lookupColumn: "status",
    foreignKey: "scheduled_task_runs_status_fkey",
    legacyCheck: "scheduled_task_runs_status_check",
    statuses: ["queued", "running", "sent", "failed", "missed"],
  });
});

test("Shopify control lifecycles are independently lookup-backed at creation", async () => {
  const [ingress, privacy, shopifyql, admin] = await Promise.all([
    readFile(new URL(
      "infra/migrations/control-plane/0130_m7_shopify_compliance_webhook_ingress.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/migrations/control-plane/0132_m8_shopify_customer_privacy_consumer.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/migrations/control-plane/0133_m6_governed_shopifyql_query_plane.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/migrations/control-plane/0134_m6_governed_shopify_admin_read_plane.sql",
      root,
    ), "utf8"),
  ]);

  const contracts: readonly Readonly<{
    sql: string;
    contract: CreatedStatusContract;
  }>[] = [
    {
      sql: ingress,
      contract: {
        table: "control_plane.shopify_compliance_inbox",
        lookup: "control_plane.shopify_compliance_inbox_status_lookup",
        statuses: ["dispatched", "unresolved"],
      },
    },
    {
      sql: privacy,
      contract: {
        table: "control_plane.shopify_privacy_cases",
        lookup: "control_plane.shopify_privacy_case_status_lookup",
        statuses: [
          "queued",
          "redaction_dispatched",
          "awaiting_operator_export",
          "export_in_progress",
          "awaiting_delivery",
          "attention_required",
          "completed",
        ],
      },
    },
    {
      sql: privacy,
      contract: {
        table: "control_plane.shopify_privacy_exports",
        lookup: "control_plane.shopify_privacy_export_status_lookup",
        statuses: ["requested", "claimed", "completed", "failed", "expired"],
      },
    },
    {
      sql: shopifyql,
      contract: {
        table: "control_plane.shopifyql_query_executions",
        lookup: "control_plane.shopifyql_query_execution_status_lookup",
        statuses: ["reserved", "succeeded", "parse_error", "failed", "response_rejected"],
      },
    },
    {
      sql: admin,
      contract: {
        table: "control_plane.shopify_admin_query_executions",
        lookup: "control_plane.shopify_admin_query_execution_status_lookup",
        statuses: ["reserved", "succeeded", "failed", "response_rejected"],
      },
    },
  ];

  assert.equal(
    new Set(contracts.map(({ contract }) => contract.lookup)).size,
    contracts.length,
    "independent Shopify state machines must not share a broadened vocabulary",
  );
  for (const { sql, contract } of contracts) {
    assertCreatedLookupBackedStatus(sql, contract);
  }
});

test("analytical reconciliation snapshot status is a dedicated lookup lifecycle", async () => {
  const sql = await readFile(new URL(
    "infra/migrations/analytical/0101_m0_lookup_backed_reconciliation_status.sql",
    root,
  ), "utf8");

  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS quality\.reconciliation_snapshot_status_lookup/iu);
  assert.doesNotMatch(sql, /REFERENCES quality\.check_status_lookup/iu);
  assertLookupBackedStatus(sql, {
    table: "quality.reconciliation_snapshot",
    lookup: "quality.reconciliation_snapshot_status_lookup",
    lookupColumn: "value",
    foreignKey: "reconciliation_snapshot_status_fkey",
    legacyCheck: "reconciliation_snapshot_status_check",
    statuses: ["running", "complete", "failed"],
  });
  assert.match(
    sql,
    /ALTER TABLE quality\.reconciliation_snapshot NO FORCE ROW LEVEL SECURITY;[\s\S]*?VALIDATE CONSTRAINT reconciliation_snapshot_status_fkey;[\s\S]*?ALTER TABLE quality\.reconciliation_snapshot FORCE ROW LEVEL SECURITY;/u,
  );
});

test("both database pipelines execute final-schema catalogue proofs", async () => {
  const [workflow, controlProof, analyticalProof] = await Promise.all([
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    readFile(new URL("tests/sql/control-plane-lookup-backed-statuses.sql", root), "utf8"),
    readFile(new URL("tests/sql/analytical-lookup-backed-statuses.sql", root), "utf8"),
  ]);

  assert.match(workflow, /tests\/sql\/control-plane-lookup-backed-statuses\.sql/u);
  assert.match(workflow, /tests\/sql\/analytical-lookup-backed-statuses\.sql/u);
  for (const proof of [controlProof, analyticalProof]) {
    assert.match(proof, /pg_catalog\.pg_constraint/u);
    assert.match(proof, /convalidated/u);
    assert.match(proof, /legacy[\s\S]*status[\s\S]*check/iu);
  }
});
