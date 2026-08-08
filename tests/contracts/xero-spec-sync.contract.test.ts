import assert from "node:assert/strict";
import test from "node:test";
import {
  XERO_ATTACHMENT_PARENTS,
  XERO_HISTORY_PARENTS,
  extraParamPasses,
  fanOutRequests,
  fanOutSkippable,
  normalizeXeroValue,
  projectRowFields,
  projectStreamRows,
  resolveFanOutIds,
  templatedParents,
  unwrapEnvelope,
} from "../../connectors/xero/spec-sync.js";
import type { XeroFanOutScan, XeroSpecTable } from "../../connectors/xero/scan-plan.js";

const column = (name: string, api: string, type = "text") => ({
  name, type, api, description: "test", key: false, pii: false,
  loadBearing: false, deprecated: false, enums: null, coversNested: [],
});

const tableOf = (partial: Partial<XeroSpecTable> & { id: string }): XeroSpecTable => ({
  domain: "invoicing",
  grain: "test",
  description: "test",
  additivity: "reference",
  additivityAxis: null,
  primaryKey: [],
  recordIdField: null,
  source: {
    api: "accounting", endpointOp: "GET /Invoices", envelope: "Invoices", arrayKey: "Invoices",
    explodePath: null, parentTable: null, fanOutParam: null, pagination: "page",
    modifiedField: "UpdatedDateUTC", whereFilterable: true, scopes: [], availability: "required",
  },
  sourceObjects: ["accounting:Invoice"],
  canonicalTargets: [],
  gotchas: [],
  columns: [],
  ...partial,
} as XeroSpecTable);

test("Xero /Date(ms)/ values normalize to ISO and everything else passes through", () => {
  assert.equal(normalizeXeroValue("/Date(1539993600000+0000)/"), "2018-10-20T00:00:00.000Z");
  assert.equal(normalizeXeroValue("/Date(1539993600000)/"), "2018-10-20T00:00:00.000Z");
  assert.equal(normalizeXeroValue("2026-08-01"), "2026-08-01");
  assert.equal(normalizeXeroValue(42), 42);
});

test("envelopes unwrap: accounting resource key, v2 lowercase wrapper, bare array, fallback", () => {
  const invoices = tableOf({ id: "xero_invoices" });
  assert.deepEqual(unwrapEnvelope({ Invoices: [{ a: 1 }] }, invoices), [{ a: 1 }]);
  const employee = tableOf({
    id: "xero_payroll_uk_employees",
    source: { ...invoices.source, api: "payroll_uk", endpointOp: "GET /Employees", envelope: "Employees", arrayKey: "Employee" },
  });
  assert.deepEqual(unwrapEnvelope({ pagination: {}, employee: { id: "e1" } }, employee), [{ id: "e1" }]);
  assert.deepEqual(unwrapEnvelope([{ id: "c1" }], invoices), [{ id: "c1" }]);
  assert.deepEqual(unwrapEnvelope({ Whatever: [{ id: "x" }] }, tableOf({ id: "t", source: { ...invoices.source, arrayKey: null } })), [{ id: "x" }]);
});

test("nested explode projects parent-root and element-root provenance and mints ordinals", () => {
  const lines = tableOf({
    id: "xero_invoice_line_items",
    recordIdField: "LineItemID",
    sourceObjects: ["accounting:LineItem"],
    source: { ...tableOf({ id: "x" }).source, explodePath: "Invoice.LineItems", parentTable: "xero_invoices", pagination: "parent" },
    columns: [
      column("invoice_id", "accounting:Invoice.InvoiceID"),
      column("line_item_id", "accounting:LineItem.LineItemID"),
      column("quantity", "accounting:LineItem.Quantity", "numeric"),
      column("line_index", "synthetic:zero-based position in Invoice.LineItems", "integer"),
    ],
  });
  const leader = tableOf({ id: "xero_invoices", recordIdField: "InvoiceID" });
  const rows = projectStreamRows({
    table: lines,
    leaderTable: leader,
    resource: "Invoices",
    records: [{
      InvoiceID: "inv-1",
      UpdatedDateUTC: "/Date(1539993600000+0000)/",
      LineItems: [
        { LineItemID: "li-1", Quantity: "2.0000" },
        { Quantity: "1.0000" },
      ],
    }],
    recordIdField: "LineItemID",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sourceRecordId, "li-1");
  assert.equal(rows[0].normalized?.fields.InvoiceID, "inv-1");
  assert.equal(rows[0].normalized?.fields.line_index, 0);
  assert.equal(rows[1].sourceRecordId, "inv-1:1", "an id-less child keys on parent id + position");
  assert.equal(rows[1].normalized?.fields.line_index, 1);
  assert.equal(rows[0].sourceObjectType, "Invoices");
});

test("archived and deleted statuses tombstone; money rides exact-decimal normalization", () => {
  const contacts = tableOf({
    id: "xero_contacts",
    recordIdField: "ContactID",
    sourceObjects: ["accounting:Contact"],
    source: { ...tableOf({ id: "x" }).source, endpointOp: "GET /Contacts", envelope: "Contacts", arrayKey: "Contacts" },
    columns: [
      column("contact_id", "accounting:Contact.ContactID"),
      column("contact_status", "accounting:Contact.ContactStatus"),
    ],
  });
  const rows = projectStreamRows({
    table: contacts, leaderTable: contacts, resource: "Contacts",
    records: [
      { ContactID: "c-1", ContactStatus: "ARCHIVED" },
      { ContactID: "c-2", ContactStatus: "ACTIVE" },
    ],
    recordIdField: "ContactID",
  });
  assert.equal(rows[0].normalized?.tombstone, true);
  assert.equal(rows[1].normalized?.tombstone, false);
});

test("fan-out requests substitute path params, fall back to query params, and harvest stubs", () => {
  const base = tableOf({ id: "xero_payroll_au_payslips" });
  const pathFan: XeroFanOutScan = {
    table: tableOf({
      id: "xero_payroll_au_payslips",
      source: { ...base.source, api: "payroll_au", endpointOp: "GET /Payslip/{PayslipID}", fanOutParam: "PayslipID", parentTable: "xero_payroll_au_pay_runs", pagination: "parent" },
    }),
    parentTable: "xero_payroll_au_pay_runs",
    endpointOp: "GET /Payslip/{PayslipID}",
    fanOutParam: "PayslipID",
    members: [],
  };
  const parentTable = tableOf({ id: "xero_payroll_au_pay_runs", recordIdField: "PayRunID" });
  const viaStubs = fanOutRequests(pathFan, [
    { PayRunID: "pr-1", Payslips: [{ PayslipID: "ps-1" }, { PayslipID: "ps-2" }] },
  ], parentTable);
  assert.deepEqual(viaStubs.map((request) => request.parentId), ["ps-1", "ps-2"]);
  assert.ok(viaStubs[0].path.endsWith("/Payslip/ps-1"));

  const queryFan: XeroFanOutScan = {
    table: tableOf({
      id: "xero_payroll_uk_payslips",
      source: { ...base.source, api: "payroll_uk", endpointOp: "GET /Payslips", fanOutParam: "PayRunID", parentTable: "xero_payroll_uk_pay_runs", pagination: "parent" },
    }),
    parentTable: "xero_payroll_uk_pay_runs",
    endpointOp: "GET /Payslips",
    fanOutParam: "PayRunID",
    members: [],
  };
  const ukParent = tableOf({ id: "xero_payroll_uk_pay_runs", recordIdField: "PayRunID" });
  const viaQuery = fanOutRequests(queryFan, [{ PayRunID: "pr-9" }], ukParent);
  assert.equal(viaQuery.length, 1);
  assert.deepEqual(viaQuery[0].params, { PayRunID: "pr-9" });
});

test("attachment sub-requests are skippable only when the parent denies having any", () => {
  const fan: XeroFanOutScan = {
    table: tableOf({
      id: "xero_attachments",
      source: { ...tableOf({ id: "x" }).source, endpointOp: "GET /{Endpoint}/{Guid}/Attachments", fanOutParam: "Guid", pagination: "parent" },
    }),
    parentTable: "",
    endpointOp: "GET /{Endpoint}/{Guid}/Attachments",
    fanOutParam: "Guid",
    members: [],
  };
  assert.equal(fanOutSkippable(fan, { HasAttachments: false }), true);
  assert.equal(fanOutSkippable(fan, { HasAttachments: true }), false);
  assert.equal(fanOutSkippable(fan, {}), false, "no flag is not permission to skip");
});

test("hidden populations: assets walk one pass per status, 1099 one pass per amendable year", () => {
  const assets = tableOf({
    id: "xero_assets",
    source: { ...tableOf({ id: "x" }).source, api: "assets", endpointOp: "GET /Assets", envelope: "Assets", arrayKey: "items" },
  });
  assert.deepEqual(
    extraParamPasses(assets, "2026-08-06T00:00:00.000Z").map((pass) => pass.status),
    ["REGISTERED", "DRAFT", "DISPOSED"],
  );
  const tnn = tableOf({
    id: "xero_1099_reports",
    source: { ...tableOf({ id: "x" }).source, endpointOp: "GET /Reports/TenNinetyNine", envelope: "Reports", arrayKey: "Reports" },
  });
  assert.deepEqual(
    extraParamPasses(tnn, "2026-08-06T00:00:00.000Z").map((pass) => pass.reportYear),
    ["2025", "2024", "2023", "2022"],
  );
});

test("templated cross-parent fan-outs resolve to the exact spec-documented parent sets", () => {
  const attachments: XeroFanOutScan = {
    table: tableOf({ id: "xero_attachments" }),
    parentTable: "",
    endpointOp: "GET /{Endpoint}/{Guid}/Attachments",
    fanOutParam: "Guid",
    members: [],
  };
  assert.equal(templatedParents(attachments), XERO_ATTACHMENT_PARENTS);
  assert.equal(XERO_ATTACHMENT_PARENTS.length, 11);
  const history: XeroFanOutScan = { ...attachments, endpointOp: "GET /{Endpoint}/{Guid}/History" };
  assert.equal(templatedParents(history), XERO_HISTORY_PARENTS);
  assert.equal(XERO_HISTORY_PARENTS.length, 16);
});

test("parent-root columns resolve against the walked record, not the element", () => {
  const table = tableOf({
    id: "xero_credit_note_allocations",
    sourceObjects: ["accounting:Allocation"],
    source: { ...tableOf({ id: "x" }).source, endpointOp: "GET /CreditNotes", envelope: "CreditNotes", arrayKey: "CreditNotes", explodePath: "CreditNote.Allocations", parentTable: "xero_credit_notes", pagination: "parent" },
    columns: [
      column("credit_note_id", "accounting:CreditNote.CreditNoteID"),
      column("amount", "accounting:Allocation.Amount", "numeric"),
      column("invoice_id", "accounting:Allocation.Invoice.InvoiceID"),
    ],
  });
  const fields = projectRowFields(
    table,
    {
      element: { Amount: "50.0000", Invoice: { InvoiceID: "inv-7" } },
      ancestors: [{ CreditNoteID: "cn-1" }],
      ordinal: 0,
      path: [0],
    },
    { CreditNoteID: "cn-1" },
    null,
  );
  assert.equal(fields.CreditNoteID, "cn-1");
  assert.equal(fields.Amount, "50.0000");
  assert.equal(fields.Invoice_InvoiceID, "inv-7", "one-hop nested provenance flattens with the path-joined field name");
});

/* ------------------------------------------------------------------ */
/* Regressions found by auditing a live tenant's ingested data.        */
/* ------------------------------------------------------------------ */

test("id-less rows of one sub-response get distinct identities", () => {
  // Every history event of a document used to key as `<parentId>:0`, so a
  // 1,162-row fan-out staged nothing: the batch aborted on duplicate keys, and
  // on the worker path the rows silently overwrote each other.
  const history = tableOf({
    id: "xero_history_records",
    recordIdField: null,
    sourceObjects: ["accounting:HistoryRecord"],
    source: { ...tableOf({ id: "x" }).source, endpointOp: "GET /{Endpoint}/{Guid}/History", fanOutParam: "Guid", pagination: "parent", arrayKey: "HistoryRecords" },
    columns: [column("changes", "accounting:HistoryRecord.Changes"), column("details", "accounting:HistoryRecord.Details")],
  });
  const parent = tableOf({ id: "xero_invoices", recordIdField: "InvoiceID" });
  const rows = projectStreamRows({
    table: history,
    leaderTable: history,
    resource: "HistoryRecords",
    records: [
      { Changes: "Created", Details: "first" },
      { Changes: "Edited", Details: "second" },
      { Changes: "Approved", Details: "third" },
    ],
    recordIdField: "",
    fanOutParent: { record: { InvoiceID: "inv-1" }, table: parent },
  });
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.sourceRecordId)).size, 3,
    "three history events of one invoice must be three records, not one");
});

test("a citation that walks upward into an enclosing object resolves", () => {
  // `Allocation.Overpayment.OverpaymentID` on an allocation row: the root names
  // the allocation, then descends into the overpayment it came off. Discarding
  // the root left every overpayment allocation with a null parent key.
  const allocations = tableOf({
    id: "xero_overpayment_allocations",
    sourceObjects: ["accounting:Allocation"],
    source: { ...tableOf({ id: "x" }).source, explodePath: "Overpayment.Allocations", parentTable: "xero_overpayments", pagination: "parent" },
    columns: [
      column("overpayment_overpayment_id", "accounting:Allocation.Overpayment.OverpaymentID"),
      column("amount", "accounting:Allocation.Amount", "numeric"),
    ],
  });
  const fields = projectRowFields(
    allocations,
    {
      element: { Amount: "1039.96", Overpayment: { OverpaymentID: "op-1" } },
      ancestors: [{ OverpaymentID: "op-1" }],
      ordinal: 0,
      path: [0],
    },
    { OverpaymentID: "op-1" },
    null,
  );
  assert.equal(fields.Overpayment_OverpaymentID, "op-1",
    "an allocation must stay attributable to the overpayment it came off");
});

test("fan-out ids resolve by parameter, by stub, and by the parent's own id", () => {
  const payRun = tableOf({ id: "xero_payroll_au_pay_runs", recordIdField: "PayRunID" });
  // Named exactly.
  assert.deepEqual(resolveFanOutIds("PayslipID", { PayslipID: "ps-1" }, payRun), ["ps-1"]);
  // Carried as stubs one array level down — the AU payslip case, which both
  // drivers previously skipped while reporting "no reachable parents".
  assert.deepEqual(
    resolveFanOutIds("PayslipID", { PayRunID: "pr-1", Payslips: [{ PayslipID: "a" }, { PayslipID: "b" }] }, payRun),
    ["a", "b"],
  );
  // The parent's own declared id, when that is what the parameter names.
  assert.deepEqual(resolveFanOutIds("PayRunID", { PayRunID: "pr-9" }, payRun), ["pr-9"]);
  assert.deepEqual(resolveFanOutIds("PayslipID", { PayRunID: "pr-9" }, payRun), ["pr-9"],
    "a parent with no better answer still addresses the sub-resource");
  assert.deepEqual(resolveFanOutIds("", { PayRunID: "pr-9" }, payRun), []);
});

test("a row with no vendor id prefers its declared key over its position", () => {
  // Organisation entitlements have a natural key (Name) that was staged and
  // ignored, so a reordered response reassigned every row's meaning.
  const actions = tableOf({
    id: "xero_organisation_actions",
    recordIdField: null,
    sourceObjects: ["accounting:Action"],
    primaryKey: ["name"],
    columns: [column("name", "accounting:Action.Name"), column("status", "accounting:Action.Status")],
  });
  const rows = projectStreamRows({
    table: actions,
    leaderTable: actions,
    resource: "Actions",
    records: [
      { Name: "ViewAccounts", Status: "ALLOWED" },
      { Name: "DeleteDraftBill", Status: "ALLOWED" },
    ],
    recordIdField: "",
  });
  assert.ok(rows[0]!.sourceRecordId.includes("ViewAccounts"));
  assert.ok(rows[1]!.sourceRecordId.includes("DeleteDraftBill"));
});
