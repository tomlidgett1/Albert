import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("tenant deletion remains user-observable without retaining a tenant anchor", async () => {
  const [migration, statusRoute, sessionRoute, page, workspace, organisation, sql, concurrencySql, ci] = await Promise.all([
    readFile(new URL(
      "infra/migrations/control-plane/0053_m8_user_bound_tenant_deletion_receipts.sql",
      root,
    ), "utf8"),
    readFile(new URL("app/api/tenant/deletion/route.ts", root), "utf8"),
    readFile(new URL("app/api/session/route.ts", root), "utf8"),
    readFile(new URL("app/dash/page.tsx", root), "utf8"),
    readFile(new URL("app/dash/components/TenantDeletionWorkspace.tsx", root), "utf8"),
    readFile(new URL("app/dash/components/OrganizationWorkspace.tsx", root), "utf8"),
    readFile(new URL("tests/sql/control-plane-tenant-deletion-receipt.sql", root), "utf8"),
    readFile(new URL("tests/sql/control-plane-tenant-deletion-concurrency.sql", root), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
  ]);

  const tableStart = migration.indexOf("CREATE TABLE IF NOT EXISTS control_plane.tenant_deletion_receipts");
  const tableEnd = migration.indexOf("COMMENT ON TABLE control_plane.tenant_deletion_receipts", tableStart);
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  const table = migration.slice(tableStart, tableEnd);
  assert.doesNotMatch(table, /tenant_id/iu);
  assert.doesNotMatch(table, /display_name|organisation_name|source_record|payload/iu);
  assert.match(table, /requested_by uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/iu);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/iu);
  assert.match(migration, /REVOKE ALL ON TABLE control_plane\.tenant_deletion_receipts[\s\S]*authenticated/iu);
  assert.match(migration, /deletion_requests_sync_user_receipt[\s\S]*AFTER INSERT OR UPDATE/iu);
  assert.match(migration, /deletion_proofs_complete_user_receipt[\s\S]*AFTER INSERT/iu);
  assert.match(migration, /receipt\.requested_by = p_requested_by/iu);
  assert.match(migration, /public\.current_albert_tenant_deletion_receipt\(\)/u);
  assert.match(migration, /public\.albert_tenant_deletion_receipt\([\s\S]*auth\.uid\(\)/u);
  assert.match(migration, /public\.current_albert_session_state\(\)[\s\S]*context_value[\s\S]*receipt_value/u);
  assert.match(migration, /receipt_status IN \([\s\S]*'queued'[\s\S]*'failed'[\s\S]*context_value := NULL/u);

  for (const routine of ["bootstrap_albert_tenant", "albert_create_organisation"]) {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${routine}`);
    assert.ok(start >= 0, `${routine} must be superseded in the receipt migration`);
    const end = migration.indexOf("$$;", start);
    const body = migration.slice(start, end);
    assert.match(body, /tenant_deletion_receipts[\s\S]*'failed'/u);
    assert.match(body, /tenant deletion is still in progress[\s\S]*55000/u);
    assert.match(body, /pg_advisory_xact_lock[\s\S]*albert:tenant-bootstrap/u);
  }
  const requestStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.albert_request_tenant_deletion");
  const requestEnd = migration.indexOf("$$;", requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  assert.match(migration.slice(requestStart, requestEnd), /pg_advisory_xact_lock[\s\S]*require_current_tenant_id/u);

  const receiptLookup = statusRoute.indexOf('"albert_tenant_deletion_receipt"');
  const membershipLookup = statusRoute.indexOf('"albert_deletion_status"');
  assert.ok(receiptLookup >= 0 && membershipLookup > receiptLookup);
  assert.match(sessionRoute, /currentTenantSessionState\(\)/u);
  assert.match(sessionRoute, /deletionReceipt:\s*sessionState\.deletionReceipt/u);
  assert.match(sessionRoute, /needsBootstrap:\s*sessionState\.needsBootstrap/u);
  assert.match(page, /parseTenantDeletionReceipt\(sessionPayload\.deletionReceipt\)/u);
  assert.match(page, /if \(nextDeletionReceipt && !sessionPayload\.context\)[\s\S]*return;/u);
  assert.match(page, /tenantDeletionReceipt \? \([\s\S]*TenantDeletionWorkspace/u);
  assert.match(organisation, /setEraseConfirmation\(""\);\s*onOrganisationChanged\?\.\(\)/u);

  assert.match(workspace, /setInterval\(\(\) => void refresh\(true\), 5_000\)/u);
  assert.match(workspace, /Download proof/u);
  assert.match(workspace, /albert\.tenant-deletion-receipt/u);
  assert.match(workspace, /receipt\.status === "completed"[\s\S]*Start a new organisation/u);
  assert.match(workspace, /fetch\("\/api\/organisations"[\s\S]*method: "POST"/u);

  assert.match(sql, /approved deletion must remove active tenant context/u);
  assert.match(sql, /bootstrap created a replacement tenant during deletion/u);
  assert.match(sql, /explicit organisation creation bypassed active deletion/u);
  assert.match(sql, /another authenticated user must not discover the receipt/u);
  assert.match(sql, /authenticated must have no direct receipt-table reads/u);
  assert.match(sql, /completed deletion must permit an explicit replacement organisation/u);
  assert.match(concurrencySql, /dblink_send_query[\s\S]*albert_test_create_during_deletion/u);
  assert.match(concurrencySql, /dblink_is_busy[\s\S]*organisation creation must wait/u);
  assert.match(concurrencySql, /current_albert_session_state\(\)[\s\S]*queued deletion must dominate/u);
  assert.match(ci, /control-plane-tenant-deletion-receipt\.sql/u);
  assert.match(ci, /control-plane-tenant-deletion-concurrency\.sql/u);
});
