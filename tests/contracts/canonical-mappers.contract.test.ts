import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mapDeputyCanonical } from "../../connectors/deputy/canonical.js";
import { deputyManifest } from "../../connectors/deputy/manifest.js";
import { mapLightspeedCanonical } from "../../connectors/lightspeed-r/canonical.js";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest.js";
import { classifyXeroAccount, mapXeroCanonical } from "../../connectors/xero/canonical.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";
import {
  buildIdentitySuggestions,
  type IdentitySourceObservation,
} from "../../packages/canonical-schema/src/index.js";
import {
  buildStagingContracts,
  projectSourceRecord,
  projectStagingFields,
  stagingColumnName,
  type ConnectorManifest,
} from "../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import type {
  CanonicalMappingContext,
  CanonicalProjectionCommand,
  CanonicalStagingRow,
  CanonicalStreamMapper,
  CanonicalTransformBatch,
} from "../../services/sync-workers/src/canonical-contract.js";
import { isCanonicalSourceReference } from "../../services/sync-workers/src/canonical-contract.js";
import {
  assertCanonicalCommandAdmission,
  assertCanonicalCommandAuthority,
  isolateCanonicalMappings,
  isolateCanonicalProjectionReferences,
} from "../../services/sync-workers/src/canonical-pipeline.js";

type Fixture = Readonly<{ responses: Readonly<Record<string, unknown>> }>;
type JsonObject = Readonly<Record<string, unknown>>;

// Ordered so the connectors this suite owns assert before any in-flight
// rebuild of another pack can halt the shared loops.
const manifests = [lightspeedRManifest, deputyManifest, xeroManifest] as const;
const contracts = buildStagingContracts(manifests);
const fixtureByConnector = new Map([
  ["lightspeed-r", readFixture("../../connectors/lightspeed-r/fixtures/sanitized-recording.json")],
  ["xero", readFixture("../../connectors/xero/fixtures/sanitized-recording.json")],
  ["deputy", readFixture("../../connectors/deputy/fixtures/sanitized-recording.json")],
]);
const mapperByConnector: Readonly<Record<string, CanonicalStreamMapper>> = {
  "lightspeed-r": mapLightspeedCanonical,
  xero: mapXeroCanonical,
  deputy: mapDeputyCanonical,
};
const context: CanonicalMappingContext = {
  timezone: "Pacific/Auckland",
  baseCurrency: "NZD",
  tradingDayCutoff: "04:00",
};

test("every declared connector stream produces non-empty, schema-bounded canonical commands", () => {
  // The cross-pack stream count is derived from the manifests at runtime: a
  // pack widening its spec must widen this suite's coverage automatically
  // rather than tripping a stale hand-pinned total.
  const declaredStreams = manifests.reduce((count, manifest) => count + manifest.streams.length, 0);
  let streamCount = 0;
  for (const manifest of manifests) {
    const fixture = fixtureByConnector.get(manifest.id);
    assert.ok(fixture);
    const mapper = mapperByConnector[manifest.id];
    assert.ok(mapper);
    for (const stream of manifest.streams) {
      const records = fixtureRecords(manifest, fixture, stream.id);
      assert.ok(records.length > 0, `${manifest.id}.${stream.id} has no fixture records`);
      for (const record of records) {
        const row = stagingRow(manifest, stream.id, record);
        const commands = mapper(stream.id, row, context);
        assert.ok(commands.length > 0, `${manifest.id}.${stream.id} emitted no command`);
        assertCommandsWellFormed(commands, `${manifest.id}.${stream.id}`);
        for (const command of commands) {
          assert.doesNotThrow(
            () => assertCanonicalCommandAdmission(command, stream),
            `${manifest.id}.${stream.id}.${command.kind} is not admitted by its manifest`,
          );
        }
        // A stream with no mapper of its own must still say something: the
        // observed lookup-only classification, never zero commands.
        if (
          manifest.id === "lightspeed-r" &&
          stream.canonicalTargets.length === 1 &&
          stream.canonicalTargets[0] === "metadata"
        ) {
          for (const command of commands) {
            assert.equal(command.kind, "metadata", `${stream.id} may only observe`);
            if (command.kind !== "metadata") assert.fail(`${stream.id} may only observe`);
            assert.equal(command.classification, "lookup_only");
            assert.equal(command.sourceRecordId, row.source_record_id);
          }
        }
      }
      streamCount += 1;
    }
  }
  assert.equal(streamCount, declaredStreams);
  assert.ok(streamCount >= lightspeedRManifest.streams.length);
});

test("every canonical command kind is denied when its exact target is undeclared", () => {
  const commands: readonly CanonicalProjectionCommand[] = [
    mapLightspeedCanonical("ls_items", fixtureRow("lightspeed-r", "ls_items"), context)
      .find((command) => command.kind === "dimension")!,
    mapLightspeedCanonical("ls_sales", fixtureRow("lightspeed-r", "ls_sales"), context)
      .find((command) => command.kind === "fact")!,
    mapLightspeedCanonical("ls_items", fixtureRow("lightspeed-r", "ls_items"), context)
      .find((command) => command.kind === "category_assignment")!,
    mapLightspeedCanonical("ls_sale_lines", lightspeedRefundLineRow(), context)
      .find((command) => command.kind === "event_link")!,
    mapDeputyCanonical("contacts", fixtureRow("deputy", "contacts"), context)
      .find((command) => command.kind === "identity_hint")!,
    mapLightspeedCanonical("ls_payment_types", fixtureRow("lightspeed-r", "ls_payment_types"), context)
      .find((command) => command.kind === "metadata")!,
  ];
  for (const command of commands) {
    assert.ok(command);
    assert.throws(
      () => assertCanonicalCommandAdmission(command, {
        canonicalTargets: ["legal_entity"],
        authorityConcept: "statutory_finance",
      }),
      /canonical_target_manifest_mismatch/u,
    );
  }
});

test("Deputy identity-only tombstones remain inside each stream target declaration",()=>{
  for(const stream of deputyManifest.streams){
    const row={...fixtureRow("deputy",stream.id),tombstone:true} as Record<string,unknown>;
    for(const field of deputyManifest.fieldCoverage.filter((entry)=>
      entry.stream===stream.id&&entry.field!==stream.recordIdField&&
      entry.disposition!=="unsupported")){
      row[stagingColumnName(field.field)]=null;
    }
    const commands=mapDeputyCanonical(stream.id,row as CanonicalStagingRow,context);
    assert.ok(commands.length>0);
    for(const command of commands){
      assert.doesNotThrow(()=>assertCanonicalCommandAdmission(command,stream));
    }
  }
});

test("fact command authority is bound to the exact producing stream", () => {
  const sale = mapLightspeedCanonical("ls_sales", fixtureRow("lightspeed-r", "ls_sales"), context)
    .find((command) => command.kind === "fact");
  assert.ok(sale?.kind === "fact");
  assert.doesNotThrow(() => assertCanonicalCommandAuthority(sale, "operational_sales"));
  assert.throws(
    () => assertCanonicalCommandAuthority(sale, "stock"),
    /canonical_authority_manifest_mismatch/u,
  );
});

test("email-less Deputy and Lightspeed workers retain resolvable location references", () => {
  const lightspeedWorker = mapLightspeedCanonical(
    "ls_employees",
    { ...fixtureRow("lightspeed-r", "ls_employees"), contact: null },
    context,
  ).find((command) => command.kind === "identity_hint" && command.entityType === "worker");
  const deputyWorker = mapDeputyCanonical(
    "employees",
    fixtureRow("deputy", "employees"),
    context,
  ).find((command) => command.kind === "identity_hint" && command.entityType === "worker");
  assert.ok(lightspeedWorker?.kind === "identity_hint");
  assert.ok(deputyWorker?.kind === "identity_hint");
  assert.deepEqual(lightspeedWorker.corroboratingScopeRef, {
    sourceObjectType: "Shop",
    sourceRecordId: "101",
  });
  assert.deepEqual(deputyWorker.corroboratingScopeRef, {
    sourceObjectType: "Company",
    sourceRecordId: "101",
  });
  assert.equal(lightspeedWorker.corroboratingScope, undefined);
  assert.equal(deputyWorker.corroboratingScope, undefined);
});

test("documented Xero payment and Deputy leave variants have explicit typed coverage", () => {
  const xeroPayments = contracts.find(
    (contract) => contract.connectorId === "xero" && contract.stream === "xero_payments",
  );
  const deputyLeave = contracts.find(
    (contract) => contract.connectorId === "deputy" && contract.stream === "leave",
  );
  assert.ok(xeroPayments);
  assert.ok(deputyLeave);
  assert.deepEqual(
    Object.fromEntries(
      xeroPayments.fields
        .filter((field) => ["BankAmount", "BatchPayment", "Prepayment", "Overpayment"].includes(field.sourceField))
        .map((field) => [field.sourceField, [field.column, field.type, field.disposition, field.pii]]),
    ),
    {
      BankAmount: ["bank_amount", "numeric", "canonical", "none"],
      BatchPayment: ["batch_payment", "jsonb", "canonical", "business_contact"],
      Prepayment: ["prepayment", "jsonb", "canonical", "customer_contact"],
      Overpayment: ["overpayment", "jsonb", "canonical", "customer_contact"],
    },
  );

  const xeroPaymentCoverage = Object.fromEntries(
    xeroManifest.fieldCoverage
      .filter((field) => field.stream === "payments")
      .map((field) => [field.field, field]),
  );
  const deputyLeaveCoverage = Object.fromEntries(
    deputyManifest.fieldCoverage
      .filter((field) => field.stream === "leave")
      .map((field) => [field.field, field]),
  );
  assert.equal(xeroPaymentCoverage.BankAmount?.target, "event_link.evidence.bank_amount");
  assert.equal(xeroPaymentCoverage.Prepayment?.target, "event_link.to.source_record_id");
  assert.equal(xeroPaymentCoverage.Overpayment?.target, "event_link.to.source_record_id");
  assert.equal(xeroPaymentCoverage.BatchPayment?.target, "event_link.to.source_record_id");
  assert.equal(deputyLeaveCoverage.Start?.target, "workforce_leave.started_at");
  assert.equal(deputyLeaveCoverage.End?.target, "workforce_leave.ended_at");
  assert.equal(deputyLeaveCoverage.TimeZone?.target, "source_deputy.leave.time_zone");
  assert.equal(deputyLeaveCoverage._DPMetaData?.disposition, "unsupported");
  assert.match(
    deputyLeaveCoverage._DPMetaData?.reason ?? "",
    /immutable raw storage only/iu,
  );
  assert.deepEqual(
    Object.fromEntries(
      deputyLeave.fields
        .filter((field) => ["Start", "End", "TimeZone"].includes(field.sourceField))
        .map((field) => [field.sourceField, [field.column, field.type, field.disposition, field.pii]]),
    ),
    {
      Start: ["start", "timestamptz", "canonical", "payroll_sensitive"],
      End: ["end", "timestamptz", "canonical", "payroll_sensitive"],
      TimeZone: ["time_zone", "text", "governed_extension", "none"],
    },
  );

  const payment = fixtureRow("xero", "xero_payments");
  const leave = fixtureRow("deputy", "leave");
  assert.equal(payment.bank_amount, "1499.0000");
  assert.equal(asObject(payment.prepayment), null);
  assert.equal(leave.start, "2026-08-09T14:00:00.000Z");
  assert.equal(leave.end, "2026-08-10T13:59:59.000Z");
  assert.equal(leave.time_zone, "Australia/Melbourne");
});

test("Lightspeed expands sale detail, keeps exact components, and uses tenant-local context", () => {
  // The sale walk is split: the header stream owns the order (plus the
  // synthetic channel and register stub), lines own order lines, payments own
  // tenders. Each stream projects its own economic event exactly once.
  const saleRow = fixtureRow("lightspeed-r", "ls_sales");
  const headerCommands = mapLightspeedCanonical("ls_sales", saleRow, context);
  const order = upsert(headerCommands, "commerce_order");
  assert.equal(upserts(headerCommands, "commerce_order_line").length, 0, "the header never emits lines");
  assert.equal(upserts(headerCommands, "commerce_payment").length, 0, "the header never emits tenders");
  assert.ok(upserts(headerCommands, "channel").length === 1);
  assert.ok(upserts(headerCommands, "register").length === 1);
  assert.equal(order.values.business_date, "2026-07-31");
  assert.equal(order.values.currency, "NZD");
  assert.equal(order.values.net_amount_inc_tax, "1499.0000");
  assert.equal(order.values.tax_amount, "136.2727");

  // Per-line tax comes from the line's own calculated components, never a
  // header allocation.
  const lineRow: CanonicalStagingRow = {
    ...fixtureRow("lightspeed-r", "ls_sale_lines"),
    calc_tax1: "136.2727",
    calc_tax2: "0.0000",
  };
  const lineCommands = mapLightspeedCanonical("ls_sale_lines", lineRow, context);
  const line = upsert(lineCommands, "commerce_order_line");
  assert.equal(upserts(lineCommands, "commerce_order").length, 0, "the same economic event cannot project twice");
  assert.equal(line.sourceRecordId, "611", "native nested IDs remain globally addressable");
  assert.equal(line.values.net_amount_inc_tax, "1499.0000");
  assert.equal(line.values.net_amount_ex_tax, "1362.7273");
  assert.equal(line.values.business_date, "2026-07-31");
  assert.deepEqual(line.values.order_id, {
    sourceRef: {
      table: "commerce_order",
      sourceObjectType: "Sale",
      sourceRecordId: "601",
      connectionId: lineRow.connection_id,
    },
  });

  const paymentCommands = mapLightspeedCanonical(
    "ls_sale_payments",
    fixtureRow("lightspeed-r", "ls_sale_payments"),
    context,
  );
  const payment = upsert(paymentCommands, "commerce_payment");
  assert.equal(upserts(paymentCommands, "commerce_order").length, 0, "the tender never emits the order");
  assert.equal(payment.sourceRecordId, "621");
  assert.deepEqual(payment.values.order_id, {
    sourceRef: {
      table: "commerce_order",
      sourceObjectType: "Sale",
      sourceRecordId: "601",
      connectionId: saleRow.connection_id,
    },
  });

  const afterMidnight: CanonicalStagingRow = {
    ...saleRow,
    complete_time: "2026-07-31T14:30:00.000Z", // 02:30 on 1 Aug in Auckland.
  };
  const cutoffOrder = upsert(
    mapLightspeedCanonical("ls_sales", afterMidnight, context),
    "commerce_order",
  );
  assert.equal(cutoffOrder.values.business_date, "2026-07-31", "04:00 cutoff belongs to prior trading day");
});

test("Lightspeed uses calculated discounts and voids archived payment attempts", () => {
  // The applied calc_* discount allocations win over the configured
  // discount_amount input and over the normal unit price.
  const line = upsert(mapLightspeedCanonical("ls_sale_lines", {
    ...fixtureRow("lightspeed-r", "ls_sale_lines"),
    unit_quantity: "2.0000",
    unit_price: "50.0000",
    normal_unit_price: "999.0000",
    discount_amount: "0.0000",
    calc_line_discount: "10.0000",
    calc_transaction_discount: "5.0000",
    calc_total: "95.0000",
    calc_tax1: "10.0000",
    calc_tax2: "0.0000",
    avg_cost: "20.0000",
  }, context), "commerce_order_line");
  assert.equal(line.values.discount_amount, "15.0000");
  assert.equal(line.values.gross_amount, "110.0000");
  assert.equal(line.values.net_amount_inc_tax, "95.0000");
  assert.equal(line.values.tax_amount, "10.0000");

  // The header reaches the same totals from its own calculated components, so
  // the split streams reconcile without either projecting the other's event.
  const order = upsert(mapLightspeedCanonical("ls_sales", {
    ...fixtureRow("lightspeed-r", "ls_sales"),
    total: "95.0000",
    calc_total: "95.0000",
    calc_discount: "15.0000",
    calc_subtotal: "100.0000",
    calc_tax1: "10.0000",
    calc_tax2: "0.0000",
  }, context), "commerce_order");
  assert.equal(order.values.gross_amount, line.values.gross_amount);
  assert.equal(order.values.discount_amount, line.values.discount_amount);
  assert.equal(order.values.net_amount_inc_tax, line.values.net_amount_inc_tax);
  assert.equal(order.values.tax_amount, line.values.tax_amount);

  const paymentBase = fixtureRow("lightspeed-r", "ls_sale_payments");
  const active = upsert(mapLightspeedCanonical("ls_sale_payments", {
    ...paymentBase,
    amount: "95.0000",
    archived: "false",
  }, context), "commerce_payment");
  const archived = upsert(mapLightspeedCanonical("ls_sale_payments", {
    ...paymentBase,
    namespaced_source_key: "lightspeed-r:account-101:SalePayment:622",
    source_record_id: "622",
    sale_payment_id: "622",
    amount: "95.0000",
    archived: "true",
  }, context), "commerce_payment");
  assert.equal(active.values.status, "captured");
  assert.equal(active.tombstone, undefined);
  assert.equal(archived.values.status, "voided");
  assert.equal(archived.tombstone, true);
});

test("Lightspeed refunds become reversal facts linked to the native original sale line", () => {
  const row = lightspeedRefundLineRow();
  const commands = mapLightspeedCanonical("ls_sale_lines", row, context);
  const refundOrderLine = upsert(commands, "commerce_order_line");
  const refund = upsert(commands, "commerce_refund_line");
  assert.equal(refundOrderLine.values.quantity, "-1.0000");
  assert.equal(refundOrderLine.values.order_status, "refunded");
  assert.equal(refundOrderLine.values.net_amount_inc_tax, "-100.0000");
  assert.equal(refund.sourceRecordId, "612");
  assert.equal(refund.values.quantity, "1.0000");
  assert.equal(refund.values.refund_amount_inc_tax, "100.0000");
  assert.deepEqual(refund.values.original_order_line_id, {
    sourceRef: {
      table: "commerce_order_line",
      sourceObjectType: "SaleLine",
      sourceRecordId: "611",
      connectionId: row.connection_id,
    },
  });
  const reversal = commands.find((command) => command.kind === "event_link" && command.linkType === "reversal_of");
  assert.ok(reversal);
  if (reversal.kind !== "event_link") assert.fail("Expected Lightspeed reversal evidence");
  assert.equal(reversal.to.sourceRecordId, "611");
  assert.equal(reversal.from.sourceRecordId, "612");
});

test("canonical mapping isolates malformed Xero and Lightspeed records from valid peers", () => {
  // Valid rows are built lazily so the Lightspeed scenarios can run and assert
  // even while another pack's fixtures are mid-rebuild.
  const cases = [
    {
      connectorId: "lightspeed-r" as const,
      stream: "ls_sales",
      mapper: mapLightspeedCanonical,
      valid: () => fixtureRow("lightspeed-r", "ls_sales"),
      invalid(base:CanonicalStagingRow):CanonicalStagingRow {
        return {
          ...base,
          namespaced_source_key:`lightspeed-r:${base.external_account_reference}:Sale:missing-shop`,
          source_record_id:"missing-shop",
          sale_id:"missing-shop",
          shop_id:null,
        };
      },
      errorCode:"canonical.lightspeed_canonical_id_missing",
    },
    {
      connectorId: "lightspeed-r" as const,
      stream: "ls_sale_lines",
      mapper: mapLightspeedCanonical,
      valid: () => fixtureRow("lightspeed-r", "ls_sale_lines"),
      invalid(base:CanonicalStagingRow):CanonicalStagingRow {
        return {
          ...base,
          namespaced_source_key:`lightspeed-r:${base.external_account_reference}:SaleLine:refund-without-parent`,
          source_record_id:"refund-without-parent",
          sale_line_id:"refund-without-parent",
          parent_sale_line_id:null,
          unit_quantity:"-1.0000",
          unit_price:"25.0000",
          normal_unit_price:"25.0000",
          discount_amount:"0.0000",
          calc_total:"-25.0000",
        };
      },
      errorCode:"canonical.lightspeed_refund_parent_missing",
    },
    {
      connectorId: "xero" as const,
      stream: "invoices",
      mapper: mapXeroCanonical,
      valid: () => fixtureRow("xero", "xero_invoices"),
      invalid(base:CanonicalStagingRow):CanonicalStagingRow {
        const id="00000000-0000-4000-8000-000000000099";
        return {
          ...base,
          namespaced_source_key:`xero:${base.external_account_reference}:Invoices:${id}`,
          source_record_id:id,
          invoice_id:id,
          date:null,
        };
      },
      errorCode:"canonical.xero_canonical_date_missing",
    },
  ];

  for(const scenario of cases){
    const valid=scenario.valid();
    const job:CanonicalTransformBatch={
      tenantId:valid.tenant_id,
      batchId:valid.payload_batch_id,
      syncRunId:valid.sync_run_id,
      connectionId:valid.connection_id,
      connectionGeneration:1,
      connectorId:scenario.connectorId,
      mappingVersion:valid.mapping_version,
    };
    const isolated=isolateCanonicalMappings(
      [scenario.invalid(valid),valid],job,scenario.stream,
      valid.mapping_version,scenario.mapper,context,
    );
    assert.equal(isolated.accepted.length,1,`${scenario.connectorId}.${scenario.stream} valid peer`);
    assert.equal(isolated.rejected.length,1,`${scenario.connectorId}.${scenario.stream} rejection`);
    assert.equal(isolated.rejected[0]?.errorCode,scenario.errorCode);
    assert.equal(isolated.accepted[0]?.row.source_record_id,valid.source_record_id);
    assert.ok((isolated.accepted[0]?.commands.length??0)>0);
  }
});

test("projection reference isolation preserves same-batch parents and closes rejected dependency chains", async () => {
  const base = fixtureRow("lightspeed-r", "ls_sales");
  const row = (sourceRecordId:string):CanonicalStagingRow => ({
    ...base,
    namespaced_source_key:`lightspeed-r:account-101:Sale:${sourceRecordId}`,
    source_record_id:sourceRecordId,
    sale_id:sourceRecordId,
  });
  const job:CanonicalTransformBatch={
    tenantId:base.tenant_id,batchId:base.payload_batch_id,
    syncRunId:base.sync_run_id,connectionId:base.connection_id,
    connectionGeneration:1,connectorId:"lightspeed-r",
    mappingVersion:base.mapping_version,
  };
  const missingClient:PostgresQueryClient={
    async query<Row extends Record<string,unknown>>(){
      return {rows:[] as readonly Row[]};
    },
  };
  const sourceRef=(table:"commerce_order_line"|"location",sourceRecordId:string)=>({
    sourceRef:{table,sourceObjectType:table==="location"?"Shop":"SaleLine",sourceRecordId},
  } as const);
  const parent={
    row:row("parent-row"),
    commands:[{
      kind:"fact",table:"commerce_order_line",sourceObjectType:"SaleLine",
      sourceRecordId:"parent-line",values:{line_number:"1"},
    }],
  } as const;
  const child={
    row:row("child-row"),
    commands:[{
      kind:"fact",table:"commerce_refund_line",sourceObjectType:"SaleLine",
      sourceRecordId:"refund-line",
      values:{original_order_line_id:sourceRef("commerce_order_line","parent-line")},
    }],
  } as const;

  const sameBatch=await isolateCanonicalProjectionReferences(
    missingClient,job,[parent,child],
  );
  assert.deepEqual(sameBatch.accepted.map(({row:accepted})=>accepted.source_record_id),[
    "parent-row","child-row",
  ]);
  assert.deepEqual(sameBatch.rejected,[]);

  const rejectedParent={
    ...parent,
    commands:[{
      ...parent.commands[0],
      values:{location_id:sourceRef("location","missing-shop")},
    }],
  } as const;
  const closed=await isolateCanonicalProjectionReferences(
    missingClient,job,[rejectedParent,child],
  );
  assert.deepEqual(closed.accepted,[]);
  assert.deepEqual(closed.rejected.map(({row:rejected})=>rejected.source_record_id),[
    "parent-row","child-row",
  ]);
  assert.ok(closed.rejected.every((rejection)=>
    rejection.errorCode==="canonical.canonical_reference_missing"&&
    rejection.errorPath==="$projection"
  ));
});

test("Lightspeed product mapping retains effective-dated category membership", () => {
  const row = fixtureRow("lightspeed-r", "ls_items");
  const commands = mapLightspeedCanonical("ls_items", row, context);
  const assignment = commands.find((command) => command.kind === "category_assignment");
  assert.ok(assignment);
  assert.equal(assignment.sourceRecordId, "401");
  assert.equal(assignment.productVariant.sourceRef.sourceRecordId, "401");
  assert.equal(assignment.productCategory.sourceRef.sourceRecordId, "301");
});

test("Lightspeed current balances become date-grained observations even when unchanged", () => {
  const row = fixtureRow("lightspeed-r", "ls_item_shops");
  const first = upsert(mapLightspeedCanonical("ls_item_shops", {
    ...row,
    ingested_at: "2026-08-01T02:00:00.000Z",
  }, context), "inventory_balance_snapshot");
  const unchangedNextDay = upsert(mapLightspeedCanonical("ls_item_shops", {
    ...row,
    ingested_at: "2026-08-02T02:00:00.000Z",
  }, context), "inventory_balance_snapshot");

  assert.equal(first.values.snapshot_date, "2026-08-01");
  assert.equal(unchangedNextDay.values.snapshot_date, "2026-08-02");
  assert.notEqual(first.sourceRecordId, unchangedNextDay.sourceRecordId);
  assert.match(first.sourceRecordId, /#snapshot:2026-08-01$/u);
  assert.equal(first.sourceObjectType, "ItemShopDailySnapshot");
  assert.equal(first.values.quantity_on_hand, unchangedNextDay.values.quantity_on_hand);
});

test("Lightspeed all-shops roll-up rows are observed without being projected or quarantined", () => {
  const row = fixtureRow("lightspeed-r", "ls_item_shops");
  const rollUp = { ...row, shop_id: "0" };
  const job: CanonicalTransformBatch = {
    tenantId: row.tenant_id,
    batchId: row.payload_batch_id,
    syncRunId: row.sync_run_id,
    connectionId: row.connection_id,
    connectionGeneration: 1,
    connectorId: "lightspeed-r",
    mappingVersion: row.mapping_version,
  };
  const isolated = isolateCanonicalMappings(
    [rollUp, row], job, "ls_item_shops", row.mapping_version, mapLightspeedCanonical, context,
  );

  // Consumed, not rejected: a re-run must heal the record's prior quarantine.
  assert.equal(isolated.rejected.length, 0);
  assert.equal(isolated.accepted.length, 2);
  const projectedRollUp = isolated.accepted.find(({ row: candidate }) => candidate.shop_id === "0");
  assert.ok(projectedRollUp);
  assert.equal(projectedRollUp.commands.length, 0);
  // The real per-shop row still projects its balance.
  assert.ok((isolated.accepted.find(({ row: candidate }) => candidate.shop_id !== "0")?.commands.length ?? 0) > 0);

  // A genuinely absent shop stays a mapping defect rather than a silent skip.
  const missingShop = isolateCanonicalMappings(
    [{ ...row, shop_id: null }], job, "ls_item_shops", row.mapping_version, mapLightspeedCanonical, context,
  );
  assert.equal(missingShop.accepted.length, 0);
  assert.equal(missingShop.rejected[0]?.errorCode, "canonical.lightspeed_canonical_id_missing");
});

test("Lightspeed derived costs round to the canonical scale instead of rejecting the record", () => {
  const row = fixtureRow("lightspeed-r", "ls_item_shops");
  const snapshot = upsert(mapLightspeedCanonical("ls_item_shops", {
    ...row,
    avg_cost: "6.263636364",
  }, context), "inventory_balance_snapshot");
  assert.equal(snapshot.values.unit_cost, "6.2636");

  // Money and quantity keep the exact parser: an unrepresentable value there
  // is a mapping error, not something to round away.
  assert.throws(
    () => mapLightspeedCanonical("ls_item_shops", { ...row, qoh: "1.00005" }, context),
    /lightspeed_canonical_decimal_invalid/u,
  );
});

test("Lightspeed purchase orders have one complete arrival-order-independent projection", () => {
  // Ownership is inverted from the embedded-header era: the Order header is a
  // lookup-only identity sweep, and OrderLine rows are first-class, carrying
  // projected parent context (vendor, shop, lifecycle, currency) so a line
  // maps standalone in any arrival order.
  const vendor=mapLightspeedCanonical("ls_vendors",fixtureRow("lightspeed-r","ls_vendors"),context);
  const header=mapLightspeedCanonical("ls_purchase_orders",fixtureRow("lightspeed-r","ls_purchase_orders"),context);
  const lineRow=lightspeedPurchaseOrderLineRow();
  const line=mapLightspeedCanonical("ls_purchase_order_lines",lineRow,context);
  const supplier=upsert(vendor,"supplier");
  const poLine=upsert(line,"purchase_order_line");

  assert.equal(supplier.sourceObjectType,"Vendor");
  assert.equal(supplier.sourceRecordId,"802");
  assert.deepEqual(supplier.values,{
    name:"Example Cycle Supply",abn:null,active:true,
  });
  const supplierHint=vendor.find((command)=>command.kind==="identity_hint");
  assert.ok(supplierHint?.kind==="identity_hint");
  assert.equal(supplierHint.entityType,"supplier");
  assert.equal(supplierHint.normalizedName,"example cycle supply");
  assert.equal(upserts(header,"purchase_order_line").length,0);
  assert.equal(header.length,1);
  assert.equal(header[0]?.kind,"metadata");
  if(header[0]?.kind!=="metadata")assert.fail("Expected lookup-only purchase-order header");
  assert.equal(header[0].classification,"lookup_only");
  assert.equal(header[0].sourceRecordId,"801");
  assert.ok(isCanonicalSourceReference(poLine.values.supplier_id));
  assert.deepEqual(poLine.values.supplier_id.sourceRef,{
    table:"supplier",
    sourceObjectType:supplier.sourceObjectType,
    sourceRecordId:supplier.sourceRecordId,
    connectionId:"connection-lightspeed-r",
    entityType:"supplier",
    nullable:true,
  });
  assert.notEqual(poLine.values.stock_location_id,null);
  assert.notEqual(poLine.values.ordered_at,null);
  assert.ok("expected_at" in poLine.values);
  assert.ok("received_at" in poLine.values);
  assert.equal(poLine.values.status,"completed");
  assert.equal(poLine.values.unit_cost,"800.0000");
  assert.equal(poLine.values.total_cost,"800.0000");
  assert.equal(poLine.values.received_quantity,"1.0000");

  const materialize=(sequence:readonly (readonly CanonicalProjectionCommand[])[])=>{
    let value:Readonly<Record<string,unknown>>|null=null;
    for(const commands of sequence){
      for(const command of commands){
        if((command.kind==="fact"||command.kind==="dimension")
          &&command.table==="purchase_order_line"&&!command.updateOnly){
          value={sourceObjectType:command.sourceObjectType,sourceRecordId:command.sourceRecordId,...command.values};
        }
      }
    }
    return value;
  };
  assert.deepEqual(materialize([header,line]),materialize([line,header]));
  assert.notEqual(materialize([header,line]),null,"exactly one stream projects the line");

  const deletion=mapLightspeedCanonical("ls_purchase_order_lines",{
    ...lineRow,tombstone:true,
  },context)[0];
  assert.equal(deletion?.kind,"fact");
  if(deletion?.kind!=="fact")assert.fail("Expected purchase-order deletion projection");
  assert.equal(deletion.updateOnly,true);
  assert.deepEqual(deletion.values,{status:"cancelled"});
});

test("Xero AU account types classify direct costs separately from operating expenses", () => {
  const expected: Readonly<Record<string, string>> = {
    BANK: "asset", CURRENT: "asset", FIXED: "asset", INVENTORY: "asset",
    NONCURRENT: "asset", PREPAYMENT: "asset", CURRLIAB: "liability",
    LIABILITY: "liability", TERMLIAB: "liability", EQUITY: "equity",
    REVENUE: "revenue", SALES: "revenue", OTHERINCOME: "revenue",
    DIRECTCOSTS: "cost_of_sales", DEPRECIATN: "operating_expense",
    EXPENSE: "operating_expense", OVERHEADS: "operating_expense",
  };
  for (const [type, accountClass] of Object.entries(expected)) {
    assert.equal(classifyXeroAccount(type, "EXPENSE"), accountClass, type);
  }
  assert.equal(classifyXeroAccount(undefined, "ASSET"), "asset");
  assert.equal(classifyXeroAccount("future_type", "future_class"), "unknown");
});

test("Xero nested finance rows expand without floating point and preserve posting/settlement links", () => {
  const invoiceCommands = mapXeroCanonical("xero_invoices", fixtureRow("xero", "xero_invoices"), context);
  const invoiceLine = upsert(invoiceCommands, "finance_invoice_line");
  assert.equal(invoiceLine.sourceRecordId, "00000000-0000-4000-8000-000000000014");
  assert.equal(invoiceLine.values.currency, "AUD", "source document currency overrides tenant base currency");
  assert.equal(invoiceLine.values.net_amount_ex_tax, "1362.7273");
  assert.equal(invoiceLine.values.net_amount_inc_tax, "1499.0000");

  const creditCommands = mapXeroCanonical("xero_credit_notes", fixtureRow("xero", "xero_credit_notes"), context);
  const creditLine = upsert(creditCommands, "finance_invoice_line");
  assert.equal(creditLine.values.net_amount_inc_tax, "-100.0000");
  assert.match(creditLine.sourceRecordId, /#line-item:1$/u);

  const manualCommands = mapXeroCanonical("xero_manual_journals", fixtureRow("xero", "xero_manual_journals"), context);
  assert.equal(upserts(manualCommands, "finance_journal_line").length, 2);
  const manualAccount = upsert(manualCommands, "finance_journal_line").values.gl_account_id;
  assert.deepEqual(manualAccount, {
    sourceRef: {
      table: "gl_account",
      sourceObjectType: "Accounts",
      connectionId: "connection-xero",
      nullable: false,
      lookup: { kind: "connector_natural_key", key: "gl_account_code", value: "090" },
    },
  });

  const journalCommands = mapXeroCanonical("xero_journals", fixtureRow("xero", "xero_journals"), context);
  assert.equal(upserts(journalCommands, "finance_journal_line").length, 2);
  const posting = journalCommands.find(
    (command) => command.kind === "event_link" && command.linkType === "accounting_posting_of",
  );
  assert.ok(posting);
  if (posting.kind !== "event_link") assert.fail("Expected Xero posting evidence");
  assert.equal(posting.to.sourceObjectType, "ManualJournals");

  const paymentCommands = mapXeroCanonical("xero_payments", fixtureRow("xero", "xero_payments"), context);
  assert.equal(paymentCommands.length, 2);
  const settlement = paymentCommands.find(
    (command) => command.kind === "event_link" && command.linkType === "settlement_of",
  );
  assert.equal(settlement?.kind, "event_link");
  if (settlement?.kind !== "event_link") assert.fail("Expected Xero settlement evidence");
  assert.equal(settlement.linkType, "settlement_of");
  assert.equal(settlement.to.sourceObjectType, "Invoices");
  assert.equal(settlement.to.sourceRecordId, "00000000-0000-4000-8000-000000000004");
  assert.equal(settlement.evidence.amount, "1499.0000");
  assert.equal(settlement.evidence.bank_amount, "1499.0000");
  assert.equal(settlement.evidence.bank_account_id, "00000000-0000-4000-8000-000000000007");
  const batchLink = paymentCommands.find(
    (command) => command.kind === "event_link" && command.linkType === "part_of_batch",
  );
  assert.ok(batchLink);

  for (const type of [
    "RECEIVE","RECEIVE-PREPAYMENT","RECEIVE-OVERPAYMENT","RECEIVE-TRANSFER",
  ]) {
    const bank=upsert(mapXeroCanonical("xero_bank_transactions",{
      ...fixtureRow("xero","xero_bank_transactions"),type,total:"100.0000",total_tax:"10.0000",
    },context),"finance_bank_transaction");
    assert.equal(bank.values.amount,"100.0000",`${type} must remain an inbound receipt`);
    assert.equal(bank.values.tax_amount,"10.0000");
  }
  for (const type of [
    "SPEND","SPEND-PREPAYMENT","SPEND-OVERPAYMENT","SPEND-TRANSFER",
  ]) {
    const bank=upsert(mapXeroCanonical("xero_bank_transactions",{
      ...fixtureRow("xero","xero_bank_transactions"),type,total:"100.0000",total_tax:"10.0000",
    },context),"finance_bank_transaction");
    assert.equal(bank.values.amount,"-100.0000",`${type} must remain an outbound spend`);
    assert.equal(bank.values.tax_amount,"-10.0000");
  }
  assert.throws(
    ()=>mapXeroCanonical("xero_bank_transactions",{
      ...fixtureRow("xero","xero_bank_transactions"),type:"UNREVIEWED-CASH-DIRECTION",
    },context),
    /xero_bank_transaction_type_invalid/iu,
  );

  const paymentBase: CanonicalStagingRow = {
    ...fixtureRow("xero", "xero_payments"),
    invoice: [],
    credit_note: null,
    prepayment: null,
    overpayment: null,
    batch_payment_id: null,
    batch_payment: null,
  };
  for (const [column, idField, sourceObjectType, sourceRecordId] of [
    ["credit_note", "CreditNoteID", "CreditNotes", "00000000-0000-4000-8000-000000000018"],
    ["prepayment", "PrepaymentID", "Prepayments", "00000000-0000-4000-8000-000000000017"],
    ["overpayment", "OverpaymentID", "Overpayments", "00000000-0000-4000-8000-000000000019"],
  ] as const) {
    const evidence = mapXeroCanonical("xero_payments", {
      ...paymentBase,
      [column]: { [idField]: sourceRecordId },
    }, context)[0];
    assert.equal(evidence?.kind, "event_link");
    if (evidence?.kind !== "event_link") assert.fail(`Expected ${column} settlement evidence`);
    assert.equal(evidence.to.sourceObjectType, sourceObjectType);
    assert.equal(evidence.to.sourceRecordId, sourceRecordId);
  }
  assert.throws(
    () => mapXeroCanonical("xero_payments", {
      ...paymentBase,
      invoice: { InvoiceID: "00000000-0000-4000-8000-000000000004" },
      prepayment: { PrepaymentID: "00000000-0000-4000-8000-000000000017" },
    }, context),
    /xero_canonical_payment_target_ambiguous/u,
  );
});

test("Deputy keeps planned, actual, and leave grains separate and uses tenant context", () => {
  const company = upsert(
    mapDeputyCanonical("companies", fixtureRow("deputy", "companies"), context),
    "location",
  );
  assert.equal(company.values.timezone, "Pacific/Auckland");

  const shift = upsert(
    mapDeputyCanonical("rosters", fixtureRow("deputy", "rosters"), context),
    "workforce_shift",
  );
  const timeCommands = mapDeputyCanonical("timesheets", fixtureRow("deputy", "timesheets"), context);
  const time = upsert(timeCommands, "workforce_time_entry");
  const leave = upsert(
    mapDeputyCanonical("leave", fixtureRow("deputy", "leave"), context),
    "workforce_leave",
  );
  assert.equal(shift.values.rostered_minutes, 480);
  assert.equal(time.values.worked_minutes, 480);
  assert.equal(time.values.overtime_minutes, null, "unknown overtime is never fabricated as zero");
  assert.equal(time.values.labour_cost, "264.0000");
  assert.equal(leave.values.leave_minutes, 480);
  assert.equal(leave.values.starts_at, "2026-08-09T14:00:00.000Z");
  assert.equal(leave.values.ends_at, "2026-08-10T13:59:59.000Z");
  assert.equal(leave.values.status, "approved");
  assert.equal(shift.values.currency, "NZD");
  assert.ok(timeCommands.some((command) => command.kind === "event_link"));

  const dateOnlyLeave = upsert(
    mapDeputyCanonical("leave", {
      ...fixtureRow("deputy", "leave"),
      start: null,
      end: null,
      date_start: "2026-10-04",
      date_end: "2026-10-04",
      time_zone: "Australia/Melbourne",
    }, context),
    "workforce_leave",
  );
  assert.equal(dateOnlyLeave.values.starts_at, "2026-10-03T14:00:00.000Z");
  assert.equal(dateOnlyLeave.values.ends_at, "2026-10-04T13:00:00.000Z");
  assert.throws(
    () => mapDeputyCanonical("leave", {
      ...fixtureRow("deputy", "leave"),
      end: null,
    }, context),
    /deputy_canonical_leave_interval_partial/u,
  );
});

test("Deputy rehire creates a new effective-dated episode against the same worker", () => {
  const initial=fixtureRow("deputy","employees");
  const terminated:CanonicalStagingRow={
    ...initial,
    active:false,
    termination_date:"2026-03-31",
    source_updated_at:"2026-03-31T12:00:00.000Z",
  };
  const rehired:CanonicalStagingRow={
    ...initial,
    active:true,
    start_date:"2026-07-01",
    termination_date:null,
    source_updated_at:"2026-07-01T00:00:00.000Z",
  };
  const initialEpisode=upsert(mapDeputyCanonical("employees",initial,context),"employment_episode");
  const terminatedEpisode=upsert(mapDeputyCanonical("employees",terminated,context),"employment_episode");
  const rehireEpisode=upsert(mapDeputyCanonical("employees",rehired,context),"employment_episode");
  const initialWorker=upsert(mapDeputyCanonical("employees",initial,context),"worker");
  const rehireWorker=upsert(mapDeputyCanonical("employees",rehired,context),"worker");

  assert.equal(initialEpisode.sourceRecordId,terminatedEpisode.sourceRecordId);
  assert.notEqual(initialEpisode.sourceRecordId,rehireEpisode.sourceRecordId);
  assert.match(rehireEpisode.sourceRecordId,/#episode:2026-07-01$/u);
  assert.equal(terminatedEpisode.values.effective_to,"2026-03-31");
  assert.equal(terminatedEpisode.values.status,"terminated");
  assert.equal(rehireEpisode.values.effective_from,"2026-07-01");
  assert.equal(rehireEpisode.values.effective_to,null);
  assert.equal(rehireEpisode.values.status,"active");
  assert.equal(initialWorker.sourceRecordId,rehireWorker.sourceRecordId);

  const shift=upsert(mapDeputyCanonical("rosters",fixtureRow("deputy","rosters"),context),"workforce_shift");
  assert.deepEqual(shift.values.employment_episode_id,{
    sourceRef:{
      table:"employment_episode",
      sourceObjectType:"EmployeeEpisode",
      connectionId:"connection-deputy",
      nullable:true,
      lookup:{
        kind:"employment_episode_on",
        workerSourceObjectType:"Employee",
        workerSourceRecordId:"301",
        businessDate:"2026-07-31",
      },
    },
  });
});

test("Deputy and Lightspeed fixtures produce source-neutral worker and location review candidates", () => {
  // Employee deliberately arrives before Contact: evidence references must be
  // independent of stream/batch arrival order.
  const observations = [
    ...identityObservations("deputy", "employees"),
    ...identityObservations("lightspeed-r", "ls_employees"),
    ...identityObservations("deputy", "companies"),
    ...identityObservations("lightspeed-r", "ls_shops"),
    ...identityObservations("deputy", "contacts"),
  ];
  const suggestions = buildIdentitySuggestions(observations);
  const worker = suggestions.find((suggestion) => suggestion.left.entityType === "worker");
  const location = suggestions.find((suggestion) => suggestion.left.entityType === "location");

  assert.ok(worker);
  assert.equal(worker.matchMethod, "deterministic_key");
  assert.equal(worker.matchStatus, "accepted");
  assert.equal(worker.evidence.work_email, "jamie@example.invalid");
  assert.deepEqual(
    [worker.left.sourceObjectType, worker.right.sourceObjectType].sort(),
    ["Employee", "Employee"],
    "Contact enriches the Deputy Employee but never becomes a candidate subject",
  );

  assert.ok(location);
  assert.equal(location.matchMethod, "deterministic_key");
  assert.equal(
    location.evidence.location_name_address,
    "melbourne demo\u001f1 example lane|melbourne|3000",
  );
  assert.deepEqual(
    [location.left.sourceObjectType, location.right.sourceObjectType].sort(),
    ["Company", "Shop"],
  );
  assert.equal(suggestions.length, 2);
});

test("mappers fail closed on source identity mismatch and post-staging drift", () => {
  const sale = fixtureRow("lightspeed-r", "ls_sales");
  assert.throws(
    () => mapLightspeedCanonical("ls_sales", { ...sale, undocumented_column: "drift" }, context),
    /lightspeed_canonical_staging_drift/u,
  );
  assert.throws(
    () => mapLightspeedCanonical("ls_sales", { ...sale, source_record_id: "wrong" }, context),
    /lightspeed_canonical_source_id_mismatch/u,
  );
  assert.throws(
    () => mapLightspeedCanonical("ls_sale_lines", sale, context),
    /lightspeed_canonical_source_type_mismatch/u,
  );
  assert.throws(
    () => mapLightspeedCanonical("unknown", sale, context),
    /lightspeed_canonical_stream_unsupported/u,
  );
  assert.throws(
    () => mapDeputyCanonical("unknown", fixtureRow("deputy", "employees"), context),
    /deputy_canonical_stream_unsupported/u,
  );
  assert.throws(
    () => mapXeroCanonical("xero_invoices", { ...fixtureRow("xero", "xero_invoices"), source_record_id: "wrong" }, context),
    /xero_canonical_source_id_mismatch/u,
  );
});

function readFixture(path: string): Fixture {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Fixture;
}

function fixtureRow(connectorId: string, streamId: string): CanonicalStagingRow {
  const manifest = manifests.find((candidate) => candidate.id === connectorId);
  const fixture = fixtureByConnector.get(connectorId);
  assert.ok(manifest);
  assert.ok(fixture);
  const record = fixtureRecords(manifest, fixture, streamId)[0];
  assert.ok(record);
  return stagingRow(manifest, streamId, record);
}

/**
 * A refund observation as the walk stages it: the fixture line's own row with
 * a negative quantity and the native parent line reference. Every overlaid
 * column is coverage-derived, so assertStagingRow admits the row unchanged.
 */
function lightspeedRefundLineRow(): CanonicalStagingRow {
  const base = fixtureRow("lightspeed-r", "ls_sale_lines");
  return {
    ...base,
    namespaced_source_key: `lightspeed-r:${base.external_account_reference}:SaleLine:612`,
    source_record_id: "612",
    sale_line_id: "612",
    parent_sale_line_id: "611",
    unit_quantity: "-1.0000",
    unit_price: "100.0000",
    normal_unit_price: "100.0000",
    discount_amount: "0.0000",
    calc_total: "-100.0000",
    avg_cost: "50.0000",
  };
}

/**
 * An OrderLine row as the walk stages it: the fixture line's native columns
 * plus the projected parent context (vendor, destination shop, lifecycle
 * dates, archive flag) the sanitized recording leaves to the walk.
 */
function lightspeedPurchaseOrderLineRow(): CanonicalStagingRow {
  return {
    ...fixtureRow("lightspeed-r", "ls_purchase_order_lines"),
    vendor_id: "802",
    shop_id: "101",
    complete: "true",
    ordered_date: "2026-07-01T00:00:00+00:00",
    received_date: "2026-07-10T00:00:00+00:00",
    archived: "false",
  };
}

function identityObservations(
  connectorId: "deputy" | "lightspeed-r",
  streamId: string,
): readonly IdentitySourceObservation[] {
  const mapper = mapperByConnector[connectorId];
  assert.ok(mapper);
  const row = fixtureRow(connectorId, streamId);
  return mapper(streamId, row, context)
    .filter((command): command is Extract<CanonicalProjectionCommand, { kind: "identity_hint" }> =>
      command.kind === "identity_hint"
    )
    .map((command) => Object.freeze({
      tenantId: "tenant-canonical",
      entityType: command.entityType,
      connectionId: row.connection_id,
      sourceObjectType: command.sourceObjectType,
      sourceRecordId: command.sourceRecordId,
      ...(command.externalId ? { externalId: command.externalId } : {}),
      deterministicKeys: command.deterministicKeys,
      ...(command.normalizedName ? { normalizedName: command.normalizedName } : {}),
      ...(command.corroboratingScope ? { corroboratingScope: command.corroboratingScope } : {}),
      ...(command.evidenceRefs ? { evidenceRefs: command.evidenceRefs } : {}),
      linkable: command.evidenceOnly !== true,
    }));
}

function fixtureRecords(
  manifest: ConnectorManifest,
  fixture: Fixture,
  streamId: string,
): readonly JsonObject[] {
  const stream = manifest.streams.find((candidate) => candidate.id === streamId);
  assert.ok(stream);
  const response = fixture.responses[streamId];
  const candidate = manifest.id === "deputy"
    ? response
    : asObject(response)?.[stream.resource];
  const values = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
  return values.map((value) => {
    const record = asObject(value);
    assert.ok(record);
    return record;
  });
}

function stagingRow(
  manifest: ConnectorManifest,
  streamId: string,
  record: JsonObject,
): CanonicalStagingRow {
  const stream = manifest.streams.find((candidate) => candidate.id === streamId);
  const contract = contracts.find(
    (candidate) => candidate.connectorId === manifest.id && candidate.stream === streamId,
  );
  assert.ok(stream);
  assert.ok(contract);
  const supportedFields = new Set(contract.fields.map((field) => field.sourceField));
  const stagedRecord = Object.fromEntries(
    Object.entries(record).filter(([field]) => supportedFields.has(field)),
  );
  const projected = projectStagingFields(
    contract,
    projectSourceRecord({ schemaVersion: manifest.packVersion, fields: stagedRecord }),
  );
  assert.deepEqual(projected.issues, []);
  const sourceRecordId = String(record[stream.recordIdField]);
  const updatedColumn = stream.modifiedField ? stagingColumnName(stream.modifiedField) : null;
  const updated = updatedColumn ? projected.values[updatedColumn] : null;
  const externalAccountReference = manifest.id === "xero"
    ? "00000000-0000-4000-8000-000000000001"
    : manifest.id === "lightspeed-r" ? "account-101" : "deputy-install";
  return {
    tenant_id: "tenant-canonical",
    namespaced_source_key: `${manifest.id}:${externalAccountReference}:${stream.resource}:${sourceRecordId}`,
    connection_id: `connection-${manifest.id}`,
    external_account_reference: externalAccountReference,
    source_object_type: stream.resource,
    source_record_id: sourceRecordId,
    source_version: null,
    source_updated_at: typeof updated === "string" || updated instanceof Date
      ? updated
      : "2026-07-31T00:00:00.000Z",
    payload_hash: "a".repeat(64),
    payload_batch_id: "batch-canonical",
    sync_run_id: "sync-canonical",
    tombstone: false,
    mapping_version: "canonical-v1",
    ...projected.values,
  };
}

function assertCommandsWellFormed(commands: readonly CanonicalProjectionCommand[], label: string): void {
  for (const command of commands) {
    if (command.kind === "dimension" || command.kind === "fact") {
      assert.ok(command.sourceObjectType.trim(), `${label} source object type is empty`);
      assert.ok(command.sourceRecordId.trim(), `${label} source record id is empty`);
      assert.ok(Object.keys(command.values).length > 0, `${label} values are empty`);
      for (const [key, value] of Object.entries(command.values)) {
        assert.notEqual(value, undefined, `${label}.${command.table}.${key} is undefined`);
        if (typeof value === "number") assert.ok(Number.isSafeInteger(value), `${label}.${key} is a lossy number`);
      }
    } else if (command.kind === "event_link") {
      assert.ok(command.from.sourceRecordId);
      assert.ok(command.to.sourceRecordId);
      assert.doesNotMatch(JSON.stringify(command.evidence), /undefined/u);
    } else if (command.kind === "identity_hint") {
      assert.ok(command.sourceRecordId);
    } else if (command.kind === "category_assignment") {
      assert.ok(command.productVariant.sourceRef.sourceRecordId);
      assert.ok(command.productCategory.sourceRef.sourceRecordId);
    } else {
      assert.ok(command.sourceRecordId);
    }
  }
}

function upserts(commands: readonly CanonicalProjectionCommand[], table: string) {
  return commands.filter(
    (command): command is Extract<CanonicalProjectionCommand, { kind: "dimension" | "fact" }> =>
      (command.kind === "dimension" || command.kind === "fact") && command.table === table,
  );
}

function upsert(commands: readonly CanonicalProjectionCommand[], table: string) {
  const matches = upserts(commands, table);
  assert.ok(matches[0], `Missing ${table} command`);
  return matches[0];
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
