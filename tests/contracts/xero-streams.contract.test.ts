import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_AUTHORITY_CONCEPTS } from "../../packages/canonical-schema/src/index.js";
import { CONNECTOR_EMITTED_TARGETS } from "../../packages/connector-sdk/src/contract.js";
import { stagingColumnName } from "../../packages/connector-sdk/src/index.js";
import {
  XERO_SPEC_TABLES,
  buildXeroScanPlan,
  xeroSourceField,
} from "../../connectors/xero/scan-plan.js";
import { XERO_FIELD_COVERAGE } from "../../connectors/xero/field-coverage.js";
import {
  XERO_DERIVED_STREAMS,
  XERO_SCAN_LEADERS,
  XERO_STREAMS,
} from "../../connectors/xero/streams.js";
import { xeroSchemas } from "../../connectors/xero/schemas.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";

const plan = buildXeroScanPlan();

test("there is exactly one stream per spec table", () => {
  assert.equal(XERO_STREAMS.length, XERO_SPEC_TABLES.length);
  const ids = new Set(XERO_STREAMS.map((stream) => stream.id));
  assert.equal(ids.size, XERO_SPEC_TABLES.length, "a duplicate id means one table never stages rows");
  for (const table of XERO_SPEC_TABLES) {
    assert.ok(ids.has(table.id), `${table.id} has no stream and can never be populated`);
  }
});

test("leaders, nested members and fan-outs partition the set", () => {
  assert.equal(
    XERO_SCAN_LEADERS.length + XERO_DERIVED_STREAMS.length,
    XERO_STREAMS.length,
  );
  assert.equal(XERO_SCAN_LEADERS.length, plan.groups.length,
    "one leader per scan group, no more and no fewer");
  const planned = new Set([
    ...plan.groups.flatMap((group) => group.members.map((member) => member.table.id)),
    ...plan.fanOuts.map((fanOut) => fanOut.table.id),
    ...plan.fanOuts.flatMap((fanOut) => fanOut.members.map((member) => member.table.id)),
  ]);
  assert.equal(planned.size, XERO_STREAMS.length, "the scan plan covers every stream exactly once");
});

test("a derived stream depends on the walk that produces its payload", () => {
  for (const stream of XERO_DERIVED_STREAMS) {
    if (stream.endpointOp.includes("{Endpoint}")) {
      // Templated cross-parent fan-outs walk their spec-derived parent
      // endpoints themselves and wait on nothing.
      assert.deepEqual([...stream.dependencies], []);
      continue;
    }
    assert.equal(stream.dependencies.length, 1,
      `${stream.id} must wait on exactly the walk that carries its rows`);
    if (stream.projection === "nested") {
      assert.ok(stream.derivedFrom, `${stream.id} explodes an array and must name its path`);
    }
  }
  for (const stream of XERO_SCAN_LEADERS) {
    assert.deepEqual(stream.dependencies, [], `${stream.id} is a leader and waits on nothing`);
  }
});

test("every stream declares an executable reconciliation policy", () => {
  for (const stream of XERO_STREAMS) {
    assert.ok(["walk", "nested", "fan_out"].includes(stream.projection));
    if (stream.isScanLeader) assert.equal(stream.projection, "walk");
    assert.ok(SOURCE_AUTHORITY_CONCEPTS.includes(stream.authorityConcept));
    for (const target of stream.canonicalTargets) {
      assert.ok((CONNECTOR_EMITTED_TARGETS as readonly string[]).includes(target),
        `${stream.id} declares unknown canonical target ${target}`);
    }
    if (stream.deletionStrategy === "immutable_append_only") {
      assert.equal(stream.lateEditStrategy, "append_only");
    }
    if (stream.lateEditStrategy === "modified_field") {
      assert.ok(stream.modifiedField, `${stream.id} sweeps by modified field but names none`);
    }
  }
});

test("region- and approval-gated surfaces are optional, the accounting core is not", () => {
  for (const stream of XERO_STREAMS) {
    const table = XERO_SPEC_TABLES.find((candidate) => candidate.id === stream.id)!;
    const api = table.source.api;
    if (api.startsWith("payroll_") || api === "assets" || api === "projects" || api === "files") {
      assert.equal(stream.availability, "optional",
        `${stream.id} is region/module gated and must be optional`);
    }
  }
  const journals = XERO_STREAMS.find((stream) => stream.id === "xero_journals");
  assert.ok(journals);
  assert.equal(journals.availability, "optional",
    "journals need the Advanced grant and must not fail required backfills");
  const invoices = XERO_STREAMS.find((stream) => stream.id === "xero_invoices");
  assert.ok(invoices);
  assert.notEqual(invoices.availability, "optional");
});

test("the journals feed pages by monotonic offset and never rewrites history", () => {
  const journals = XERO_STREAMS.find((stream) => stream.id === "xero_journals");
  assert.ok(journals);
  assert.equal(journals.pagination, "offset");
  assert.equal(journals.backfillStrategy, "exhaustive_offset");
  assert.equal(journals.deletionStrategy, "immutable_append_only");
  const journalLines = XERO_STREAMS.find((stream) => stream.id === "xero_journal_lines");
  if (journalLines) {
    assert.equal(journalLines.pagination, "offset",
      "journal lines ride the Journals offset walk and must declare its mechanics");
  }
});

test("staged field names are unique per stream and equal the spec column names", () => {
  for (const table of XERO_SPEC_TABLES) {
    const seen = new Set<string>();
    for (const column of table.columns) {
      const field = xeroSourceField(column);
      assert.ok(!seen.has(field), `${table.id} stages two columns as ${field}`);
      seen.add(field);
      assert.equal(stagingColumnName(field), column.name,
        `${table.id}.${column.name}: dictionary name and staged column disagree`);
    }
  }
});

test("field coverage exists for every stream and stages every column", () => {
  const byStream = new Map<string, number>();
  for (const entry of XERO_FIELD_COVERAGE) {
    byStream.set(entry.stream, (byStream.get(entry.stream) ?? 0) + 1);
    assert.notEqual(entry.disposition, "unsupported",
      `${entry.stream}.${entry.field}: the spec stages 100% of extracted fields; unsupported dispositions are not part of this pack`);
  }
  for (const table of XERO_SPEC_TABLES) {
    assert.equal(byStream.get(table.id), table.columns.length,
      `${table.id} coverage count must equal its column count`);
  }
});

test("the manifest carries the spec streams and schema record exactly", () => {
  assert.deepEqual(
    [...xeroManifest.streams.map((stream) => stream.id)].sort(),
    [...Object.keys(xeroSchemas)].sort(),
  );
  assert.equal(xeroManifest.streams.length, XERO_SPEC_TABLES.length);
});

test("every founding successor stream is present with its canonical targets", () => {
  const expectations: Readonly<Record<string, readonly string[]>> = {
    xero_organisations: ["legal_entity"],
    xero_accounts: ["gl_account"],
    xero_contacts: ["person", "customer_account", "supplier", "identity_hint", "metadata"],
    xero_invoices: ["finance_invoice_line"],
    xero_credit_notes: ["finance_invoice_line", "event_link"],
    xero_payments: ["event_link", "metadata"],
    xero_bank_transactions: ["finance_bank_transaction"],
    xero_manual_journals: ["finance_journal_line", "metadata"],
    xero_journals: ["finance_journal_line", "event_link", "metadata"],
    xero_tax_rates: ["tax_code"],
    xero_tracking_categories: ["location", "identity_hint", "metadata"],
  };
  for (const [id, targets] of Object.entries(expectations)) {
    const stream = XERO_STREAMS.find((candidate) => candidate.id === id);
    assert.ok(stream, `${id} is missing — the founding canonical mapper would be orphaned`);
    assert.deepEqual([...stream.canonicalTargets], targets);
  }
});

test("Xero payments stay settlement evidence and never fabricate POS tender facts", () => {
  const payments = XERO_STREAMS.find((stream) => stream.id === "xero_payments");
  assert.ok(payments);
  assert.equal(payments.canonicalTargets.includes("commerce_payment"), false);
  const paymentFields = XERO_FIELD_COVERAGE.filter((field) => field.stream === "xero_payments");
  assert.ok(paymentFields.length > 0);
  for (const field of paymentFields.filter((entry) => entry.disposition === "canonical")) {
    assert.ok(field.target === "event_link" || field.target?.startsWith("event_link"),
      `${field.field} projects ${field.target ?? "nothing"}; payments are evidence, not tenders`);
  }
});
