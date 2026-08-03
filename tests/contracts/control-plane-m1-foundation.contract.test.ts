import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/control-plane/0001_m1_control_plane_foundation.sql",
  import.meta.url,
);
const boundaryDocUrl = new URL(
  "../../infra/migrations/control-plane/README.md",
  import.meta.url,
);

const tenantOwnedTables = [
  "tenants",
  "memberships",
  "connections",
  "oauth_token_refs",
  "sync_runs",
  "stream_cursors",
  "readiness",
  "dossiers",
  "tenant_overlays",
  "conversations",
  "answer_artifacts",
  "answer_execution_events",
  "identity_review_tasks",
  "semantic_inbox",
  "audit_log",
  "placement_registry",
] as const;

const requiredTables = [
  ...tenantOwnedTables,
  "semantic_publications",
] as const;

async function loadMigration() {
  return readFile(migrationUrl, "utf8");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tableDefinition(sql: string, table: string) {
  const expression = new RegExp(
    `create\\s+table\\s+if\\s+not\\s+exists\\s+control_plane\\.${escapeRegExp(table)}\\s*\\(([\\s\\S]*?)\\n\\);`,
    "i",
  );
  const match = sql.match(expression);
  assert.ok(match, `missing CREATE TABLE for control_plane.${table}`);
  return match[1];
}

test("M1 migration is transactional, rerunnable, and control-plane-only", async () => {
  const sql = await loadMigration();

  assert.match(sql, /^\s*BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.match(sql, /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+control_plane/i);
  assert.match(sql, /ON\s+CONFLICT\s*\([^)]*\)\s+DO\s+NOTHING/i);
  assert.doesNotMatch(sql, /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i);
  assert.doesNotMatch(sql, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i);
  assert.doesNotMatch(sql, /CREATE\s+(?:TABLE|SCHEMA)[\s\S]*?\b(?:core|mart|quality|source_[a-z0-9_]+)\s*\./i);

  for (const table of requiredTables) {
    tableDefinition(sql, table);
  }
});

test("every tenant-owned control-plane table carries tenant_id and enables RLS", async () => {
  const sql = await loadMigration();

  for (const table of tenantOwnedTables) {
    const definition = tableDefinition(sql, table);
    assert.match(
      definition,
      /\btenant_id\s+text\b/i,
      `control_plane.${table} must carry a text tenant_id`,
    );
    assert.match(
      sql,
      new RegExp(
        `alter\\s+table\\s+control_plane\\.${escapeRegExp(table)}\\s+enable\\s+row\\s+level\\s+security\\s*;`,
        "i",
      ),
      `control_plane.${table} must enable RLS`,
    );
  }

  assert.match(
    sql,
    /function\s+control_plane\.is_tenant_member[\s\S]*from\s+control_plane\.memberships[\s\S]*membership\.user_id\s*=\s*auth\.uid\(\)/i,
  );
  assert.match(
    sql,
    /create\s+policy\s+tenant_members_read[\s\S]*using\s*\(control_plane\.is_tenant_member\(tenant_id\)\)/i,
  );
  assert.doesNotMatch(
    sql,
    /create\s+policy[\s\S]*current_setting\s*\(\s*['"](?:app\.)?tenant/i,
  );
});

test("statuses remain lookup-constrained text and readiness/answer states are complete", async () => {
  const sql = await loadMigration();

  assert.doesNotMatch(sql, /CREATE\s+TYPE[\s\S]*?AS\s+ENUM/i);
  assert.doesNotMatch(sql, /\bstatus\s+[a-z_][a-z0-9_.]*_enum\b/i);

  const constrainedStatuses = [
    ["tenants", "tenant_status_lookup"],
    ["memberships", "membership_status_lookup"],
    ["connections", "connection_status_lookup"],
    ["sync_runs", "sync_run_status_lookup"],
    ["dossiers", "version_status_lookup"],
    ["tenant_overlays", "version_status_lookup"],
    ["semantic_publications", "publication_status_lookup"],
    ["conversations", "conversation_status_lookup"],
    ["identity_review_tasks", "identity_review_status_lookup"],
    ["semantic_inbox", "semantic_inbox_status_lookup"],
    ["placement_registry", "placement_status_lookup"],
  ] as const;

  for (const [table, lookup] of constrainedStatuses) {
    assert.match(
      tableDefinition(sql, table),
      new RegExp(
        `status\\s+text[\\s\\S]*?references\\s+control_plane\\.${lookup}\\(status\\)`,
        "i",
      ),
      `${table}.status must reference ${lookup}`,
    );
  }

  for (const state of [
    "not_started",
    "syncing",
    "transforming",
    "validating",
    "ready_partial",
    "ready_complete",
    "degraded",
    "blocked",
  ]) {
    assert.match(sql, new RegExp(`\\('${state}'\\s*,`, "i"));
  }

  for (const state of [
    "verified",
    "qualified",
    "exploratory",
    "clarification",
    "unavailable",
  ]) {
    assert.match(sql, new RegExp(`\\('${state}'\\s*,`, "i"));
  }
});

test("OAuth storage is reference-only and inaccessible to authenticated users", async () => {
  const sql = await loadMigration();
  const tokenRefs = tableDefinition(sql, "oauth_token_refs");

  assert.doesNotMatch(
    sql,
    /^\s*(?:access_token|refresh_token|id_token|client_secret|token_value|token_body|plaintext|ciphertext)\s+(?:text|bytea|jsonb?)\b/im,
  );
  assert.match(tokenRefs, /\bsecret_reference\s+text\s+not\s+null\b/i);
  assert.match(tokenRefs, /\bencryption_key_version\s+text\s+not\s+null\b/i);
  assert.doesNotMatch(
    tokenRefs,
    /\b(?:access_token|refresh_token|id_token|client_secret|token_value|token_body|plaintext|ciphertext)\s+(?:text|bytea|jsonb?)\b/i,
  );
  assert.doesNotMatch(
    sql,
    /create\s+policy\s+\S+\s+on\s+control_plane\.oauth_token_refs/i,
  );
  const authenticatedGrants =
    sql.match(/grant\b[\s\S]*?\bto\s+authenticated\s*;/gi) ?? [];
  for (const grant of authenticatedGrants) {
    assert.doesNotMatch(grant, /control_plane\.oauth_token_refs/i);
  }
});

test("answer execution events have a deterministic tenant-local order", async () => {
  const events = tableDefinition(await loadMigration(), "answer_execution_events");

  assert.match(events, /\bsequence_number\s+integer\s+not\s+null\b/i);
  assert.match(
    events,
    /unique\s*\(\s*tenant_id\s*,\s*answer_artifact_id\s*,\s*sequence_number\s*\)/i,
  );
  assert.match(
    events,
    /foreign\s+key\s*\(\s*tenant_id\s*,\s*answer_artifact_id\s*\)/i,
  );
});

test("migration-owner and runtime role boundaries are documented", async () => {
  const [sql, documentation] = await Promise.all([
    loadMigration(),
    readFile(boundaryDocUrl, "utf8"),
  ]);
  const boundary = `${sql}\n${documentation}`;

  assert.match(boundary, /migration[- ]owner/i);
  assert.match(boundary, /service_role/i);
  assert.match(boundary, /authenticated/i);
  assert.match(boundary, /auth\.uid\(\)/i);
  assert.match(boundary, /must never be (?:sent|available) to (?:a )?(?:browser|runtime)/i);
  assert.match(sql, /REVOKE\s+ALL\s+ON\s+SCHEMA\s+control_plane\s+FROM\s+PUBLIC/i);
  assert.match(sql, /GRANT\s+ALL\s+PRIVILEGES\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+control_plane\s+TO\s+service_role/i);
});
