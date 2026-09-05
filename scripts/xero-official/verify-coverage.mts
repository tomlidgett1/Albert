/**
 * Field coverage verification for the XER_OFFICIAL landing schema.
 *
 * The ingest stores whole response envelopes and dlt normalises every nested
 * object/array, so a documented field can only be missing from the landed
 * columns when no record in the organisation carries it. This script makes
 * that a verified property: it diffs the columns dlt landed against the
 * pinned spec census (derived from the official OpenAPI documents) and
 * separately confirms that the critical nested child tables landed.
 *
 * Usage: npx tsx scripts/xero-official/verify-coverage.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

import { XERO_SCAN_PLAN } from "../../connectors/xero/scan-plan.js";

function loadEnv(): Record<string, string> {
  const output = { ...process.env } as Record<string, string>;
  let contents = "";
  try { contents = readFileSync(resolve(".env.local"), "utf8"); } catch { return output; }
  for (const line of contents.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[match[1]!] ??= value;
  }
  return output;
}

function resourceName(api: string, endpointOp: string): string {
  return `${api}_${endpointOp.replace(/^GET\s+/u, "")}`
    .replace(/[{}]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

/** Terminal API field name of one spec column (`Invoice.LineItems.Quantity` -> quantity). */
function terminalField(apiCitation: string): string | null {
  if (apiCitation.startsWith("synthetic:")) return null;
  const body = apiCitation.slice(apiCitation.indexOf(":") + 1).replace(/\[\]( index)?$/u, "");
  const last = body.split(".").pop() ?? "";
  return last ? last.toLowerCase() : null;
}

const env = loadEnv();
const url = env.ANALYTICAL_ADMIN_DATABASE_URL?.trim().replace(/^"|"$/gu, "");
if (!url) throw new Error("Missing ANALYTICAL_ADMIN_DATABASE_URL");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const columnsResult = await client.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns where table_schema = 'XER_OFFICIAL'`,
  );
  const manifestResult = await client.query<{ resource_name: string; status: string; records: string }>(
    `select resource_name, status, records from "XER_OFFICIAL".ingestion_manifest`,
  );
  const manifest = new Map(manifestResult.rows.map((row) => [row.resource_name, row]));

  // Fan-out detail resources land the fields their parent's list response
  // omits; fold them into the parent family before diffing.
  const familyAliases: Record<string, string> = {
    payroll_au_employees_detail: "payroll_au_employees",
    payroll_au_pay_runs_detail: "payroll_au_payruns",
    payroll_au_payslips: "payroll_au_payruns",
    accounting_budgets_detail: "accounting_budgets",
    accounting_contact_groups_detail: "accounting_contactgroups",
    files_associations: "files_files",
  };

  // Landed column names grouped by resource family (parent + dlt child tables).
  const familyColumns = new Map<string, Set<string>>();
  const familyTables = new Map<string, Set<string>>();
  for (const row of columnsResult.rows) {
    let family = row.table_name.split("__")[0]!;
    family = familyAliases[family] ?? family;
    if (!familyColumns.has(family)) {
      familyColumns.set(family, new Set());
      familyTables.set(family, new Set());
    }
    // dlt variant suffixes (`__v_double`) and child-name mangling do not
    // change the terminal field name, which is what the census compares.
    const bare = row.column_name.replace(/__v_[a-z]+$/u, "").toLowerCase();
    familyColumns.get(family)!.add(bare);
    // Nested objects flatten to `Parent__Field` columns and arrays become
    // child tables; index every path segment so both an object's own name
    // (`Contact` in `Contact__ContactID`) and terminal fields count as landed.
    for (const segment of bare.split("__")) {
      if (segment) familyColumns.get(family)!.add(segment);
    }
    for (const segment of row.table_name.toLowerCase().split("__")) {
      if (segment) familyColumns.get(family)!.add(segment);
    }
    familyTables.get(family)!.add(row.table_name);
  }

  const skipApis = new Set(["payroll_uk", "payroll_nz"]);
  type Gap = { resource: string; status: string; missing: string[]; landedColumns: number };
  const gaps: Gap[] = [];
  const covered: Gap[] = [];

  for (const group of XERO_SCAN_PLAN.groups) {
    if (skipApis.has(group.api)) continue;
    const resource = resourceName(group.api, group.endpointOp);
    const entry = manifest.get(resource);
    let status = entry?.status ?? "not_in_manifest";
    // Skipped means an earlier run today already landed it; the columns are
    // present and the diff below verifies them like any loaded resource.
    if (status === "skipped_already_loaded" || status === "partial_daily_limit") status = "loaded";
    const landed = familyColumns.get(resource) ?? new Set<string>();

    const wanted = new Set<string>();
    for (const member of group.members) {
      for (const column of member.table.columns) {
        const field = terminalField(column.api);
        if (field) wanted.add(field);
      }
    }
    const missing = [...wanted].filter((field) => !landed.has(field)).sort();
    const summary: Gap = { resource, status, missing, landedColumns: landed.size };
    if (status !== "loaded" || missing.length === 0) covered.push(summary);
    else gaps.push(summary);
  }

  // Critical nested child tables that must exist when the parent has rows.
  const nestedChecks: { parentTable: string; childPattern: RegExp; label: string }[] = [
    { parentTable: "accounting_invoices__payload__Invoices", childPattern: /^accounting_invoices__.*LineItems$/u, label: "Invoice line items" },
    { parentTable: "accounting_invoices__payload__Invoices", childPattern: /^accounting_invoices__.*Payments$/u, label: "Invoice payments" },
    { parentTable: "accounting_banktransactions__payload__BankTransactions", childPattern: /^accounting_banktransactions__.*LineItems$/u, label: "Bank transaction line items" },
    { parentTable: "accounting_creditnotes__payload__CreditNotes", childPattern: /^accounting_creditnotes__.*Allocations$/u, label: "Credit note allocations" },
    { parentTable: "accounting_creditnotes__payload__CreditNotes", childPattern: /^accounting_creditnotes__.*LineItems$/u, label: "Credit note line items" },
    { parentTable: "accounting_manualjournals__payload__ManualJournals", childPattern: /^accounting_manualjournals__.*JournalLines$/u, label: "Manual journal lines" },
    { parentTable: "accounting_batchpayments__payload__BatchPayments", childPattern: /^accounting_batchpayments__.*Payments$/u, label: "Batch payment members" },
    { parentTable: "accounting_contacts__payload__Contacts", childPattern: /^accounting_contacts__.*Addresses$/u, label: "Contact addresses" },
    { parentTable: "payroll_au_timesheets__payload__Timesheets", childPattern: /^payroll_au_timesheets__.*TimesheetLines$/u, label: "Timesheet lines" },
    { parentTable: "payroll_au_pay_runs_detail__payload__PayRuns", childPattern: /^payroll_au_pay_runs_detail__.*Payslips$/u, label: "Pay run payslip summaries" },
    { parentTable: "accounting_overpayments__payload__Overpayments", childPattern: /^accounting_overpayments__.*Allocations$/u, label: "Overpayment allocations" },
  ];
  const allTables = new Set(columnsResult.rows.map((row) => row.table_name));
  const nestedReport: { label: string; ok: boolean; detail: string }[] = [];
  for (const check of nestedChecks) {
    if (!allTables.has(check.parentTable)) {
      nestedReport.push({ label: check.label, ok: true, detail: "parent has no rows in this organisation" });
      continue;
    }
    const countResult = await client.query(`select count(*)::int as n from "XER_OFFICIAL"."${check.parentTable}"`);
    const parentRows = Number(countResult.rows[0].n);
    const childExists = [...allTables].some((table) => check.childPattern.test(table));
    nestedReport.push({
      label: check.label,
      ok: parentRows === 0 || childExists,
      detail: `parent rows=${parentRows}, child table ${childExists ? "landed" : "MISSING"}`,
    });
  }

  console.log(JSON.stringify({
    loadedResourcesWithFullFieldCoverage: covered.filter((entry) => entry.status === "loaded").length,
    resourcesNotLoaded: covered.filter((entry) => entry.status !== "loaded").map((entry) => `${entry.resource} (${entry.status})`),
    fieldGaps: gaps,
    nestedChildTables: nestedReport,
  }, null, 2));
} finally {
  await client.end();
}
