import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SQUARE_FIELD_CENSUS,
  buildSquareRuntimeFieldIndex,
  squareCensusPaths,
  squareCensusReferences,
  squareStreamFieldCoverage,
  squareTransitiveModels,
} from "../../connectors/square/field-census.js";
import { SQUARE_CONTRACT_LOCK } from "../../connectors/square/spec-lock.js";
import {
  SQUARE_CURRENCY_EXPONENT_0,
  SQUARE_CURRENCY_EXPONENT_2,
  SQUARE_CURRENCY_EXPONENT_3,
  SQUARE_CURRENCY_EXPONENT_4,
  squareCurrencyExponent,
} from "../../connectors/square/currency.js";
import {
  SQUARE_READ_STREAMS,
  buildSquareReadRequest,
  squareReadRequestContractProbe,
  squareReadStream,
  type SquareReadScope,
} from "../../connectors/square/streams.js";
import {
  CONNECTOR_EMITTED_TARGETS,
} from "../../packages/connector-sdk/src/contract.js";
import {
  SOURCE_AUTHORITY_CONCEPTS,
} from "../../packages/canonical-schema/src/types.js";

const documentedReadScopes = new Set<SquareReadScope>([
  "APPOINTMENTS_ALL_READ",
  "APPOINTMENTS_BUSINESS_SETTINGS_READ",
  "APPOINTMENTS_READ",
  "BANK_ACCOUNTS_READ",
  "CASH_DRAWER_READ",
  "CUSTOMERS_READ",
  "DEVICES_READ",
  "DISPUTES_READ",
  "EMPLOYEES_READ",
  "GIFTCARDS_READ",
  "INVENTORY_READ",
  "INVOICES_READ",
  "ITEMS_READ",
  "LOYALTY_READ",
  "MERCHANT_PROFILE_READ",
  "ONLINE_STORE_SITE_READ",
  "ONLINE_STORE_SNIPPETS_READ",
  "ORDERS_READ",
  "PAYMENTS_READ",
  "PAYMENT_METHODS_READ",
  "PAYOUTS_READ",
  "SUBSCRIPTIONS_READ",
  "TIMECARDS_READ",
  "TIMECARDS_SETTINGS_READ",
  "VENDOR_READ",
]);

const PINNED_UNSUPPORTED_SQUARE_CURRENCIES = Object.freeze([
  "UNKNOWN_CURRENCY",
  // Historical codes absent from current ISO List One.
  "ANG", "BGN", "BYR", "CUC", "HRK", "LTL", "LVL", "MRO", "SLL", "STD", "USS", "VEF", "ZMK",
  // Metal, accounting, bond-market, test and no-currency codes have no numeric minor-unit contract.
  "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XTS", "XXX",
  // Square extensions are not ISO 4217 currencies with a published numeric minor unit.
  "BTC", "XUS",
] as const);

test("Square contract is pinned to the official dated SDK wire contract", () => {
  assert.equal(SQUARE_CONTRACT_LOCK.apiVersion, "2026-07-15");
  assert.equal(SQUARE_CONTRACT_LOCK.sdk.npmSpecifier, "square@45.0.1");
  assert.equal(
    SQUARE_CONTRACT_LOCK.sdk.tarballSha256,
    "a6d08493df4a40ecc685272194eed11cd03d69c7fad54e37d858993a044d1406",
  );
  assert.equal(SQUARE_FIELD_CENSUS.apiVersion, SQUARE_CONTRACT_LOCK.apiVersion);
  assert.equal(SQUARE_FIELD_CENSUS.sdkVersion, SQUARE_CONTRACT_LOCK.sdk.version);
  assert.equal(SQUARE_FIELD_CENSUS.rawDeclarationCount, 1_406);
  assert.equal(SQUARE_FIELD_CENSUS.pinnedHeaderOccurrenceCount, 338);
  assert.equal(SQUARE_FIELD_CENSUS.rootEntities.length, 56);
  assert.equal(Object.keys(SQUARE_FIELD_CENSUS.models).length, 476);
  assert.ok(Object.values(SQUARE_CONTRACT_LOCK.sources).every((url) =>
    new URL(url).hostname === "developer.squareup.com"));
});

test("the pinned Square Currency enum has an exhaustive fail-closed base-unit policy", () => {
  const model = SQUARE_FIELD_CENSUS.models.Currency;
  assert.ok(model);
  assert.equal(model.source, "serialization/types/Currency.d.ts");
  assert.equal(model.shape.kind, "union");
  if (model.shape.kind !== "union") return;
  const enumValues = model.shape.options.map((option) => {
    assert.equal(option.kind, "scalar");
    if (option.kind !== "scalar") return "";
    assert.match(option.type, /^"[A-Z_]+"$/u);
    return JSON.parse(option.type) as string;
  });
  assert.equal(enumValues.length, 183);
  assert.equal(new Set(enumValues).size, enumValues.length);

  const classified = [
    ...SQUARE_CURRENCY_EXPONENT_0,
    ...SQUARE_CURRENCY_EXPONENT_2,
    ...SQUARE_CURRENCY_EXPONENT_3,
    ...SQUARE_CURRENCY_EXPONENT_4,
  ];
  assert.equal(classified.length, 156);
  assert.equal(new Set(classified).size, classified.length);
  assert.ok(classified.every((currency) => enumValues.includes(currency)));
  const classifiedSet = new Set<string>(classified);
  assert.deepEqual(
    enumValues.filter((currency) => !classifiedSet.has(currency)).sort(),
    [...PINNED_UNSUPPORTED_SQUARE_CURRENCIES].sort(),
  );
  for (const currency of PINNED_UNSUPPORTED_SQUARE_CURRENCIES) {
    assert.equal(squareCurrencyExponent(currency), null, currency);
  }

  // The analytical/Cube policy must be the exact same explicit partition.
  const migration = readFileSync(
    new URL("../../infra/migrations/analytical/0148_m3_square_currency_base_units.sql", import.meta.url),
    "utf8",
  );
  const caseBody = migration.split("SELECT CASE", 2)[1]?.split("ELSE NULL::smallint", 1)[0] ?? "";
  const byExponent = new Map<number, string[]>();
  for (const match of caseBody.matchAll(
    /WHEN currency_code IN \(([\s\S]*?)\)\s*THEN ([023])::smallint/gu,
  )) {
    byExponent.set(
      Number(match[2]),
      [...match[1]!.matchAll(/'([A-Z]+)'/gu)].map((candidate) => candidate[1]!),
    );
  }
  const four = /WHEN currency_code = '([A-Z]+)' THEN 4::smallint/u.exec(caseBody)?.[1];
  assert.deepEqual(byExponent.get(0), [...SQUARE_CURRENCY_EXPONENT_0]);
  assert.deepEqual(byExponent.get(2), [...SQUARE_CURRENCY_EXPONENT_2]);
  assert.deepEqual(byExponent.get(3), [...SQUARE_CURRENCY_EXPONENT_3]);
  assert.deepEqual(four ? [four] : [], [...SQUARE_CURRENCY_EXPONENT_4]);
  assert.ok(PINNED_UNSUPPORTED_SQUARE_CURRENCIES.every((currency) => !caseBody.includes(`'${currency}'`)));
});

test("all Square read streams carry production traversal and governance metadata", () => {
  assert.equal(SQUARE_READ_STREAMS.length, 64);
  assert.equal(new Set(SQUARE_READ_STREAMS.map((stream) => stream.id)).size, 64);
  const ids = new Set(SQUARE_READ_STREAMS.map((stream) => stream.id));
  const targets = new Set<string>(CONNECTOR_EMITTED_TARGETS);
  const authorities = new Set<string>(SOURCE_AUTHORITY_CONCEPTS);
  const allowedDomains = new Set(["sales", "inventory", "customers", "products", "accounting", "workforce"]);

  for (const stream of SQUARE_READ_STREAMS) {
    assert.match(stream.id, /^square_[a-z0-9_]+$/u);
    assert.match(stream.endpoint, /^\/v2\//u);
    assert.ok(stream.label.length > 0);
    assert.ok(stream.resource.length > 0);
    assert.ok(stream.responsePath.length > 0);
    assert.ok(stream.recordIdPath.length > 0);
    assert.ok(stream.documentation.startsWith("https://developer.squareup.com/"));
    assert.ok(stream.priority >= 1 && stream.priority <= 5);
    assert.ok(stream.dependencies.every((dependency) => ids.has(dependency)));
    assert.ok(!stream.dependencies.includes(stream.id));
    assert.ok(stream.productDomains.length > 0);
    assert.ok(stream.productDomains.every((domain) => allowedDomains.has(domain)));
    assert.ok(stream.canonicalTargets.length > 0);
    assert.ok(stream.canonicalTargets.every((target) => targets.has(target)));
    assert.ok(stream.authorityConcept === null || authorities.has(stream.authorityConcept));
    assert.ok(stream.scope.every((scope) => documentedReadScopes.has(scope)));
    assert.ok(SQUARE_FIELD_CENSUS.models[stream.rootEntity], `${stream.id} has no SDK census root`);
    assert.ok(squareCensusPaths(stream.rootEntity).length > 0, `${stream.id} has no queryable paths`);

    if (stream.pagination.kind === "cursor") {
      assert.equal(stream.pagination.cursorTtlSeconds, 300);
      assert.equal(stream.pagination.durableWatermark, false);
      assert.equal(stream.pagination.responsePath, "cursor");
      assert.equal(stream.cursorLocation === "none", false);
      assert.ok(stream.pagination.requestPath);
      if (stream.pagination.pageSizePath === null) {
        assert.equal(stream.pagination.defaultPageSize, null);
        assert.equal(stream.pagination.maxPageSize, null);
      } else {
        assert.ok(Number.isSafeInteger(stream.pagination.defaultPageSize));
        assert.ok(Number.isSafeInteger(stream.pagination.maxPageSize));
      }
    } else {
      assert.equal(stream.pagination.cursorTtlSeconds, null);
    }
  }

  const streamsWithoutPublishedOAuth = SQUARE_READ_STREAMS.filter((stream) => stream.scope.length === 0);
  assert.deepEqual(streamsWithoutPublishedOAuth.map((stream) => stream.id), ["square_channels"]);
  assert.equal(streamsWithoutPublishedOAuth[0]!.availability.sellerOAuth, "undocumented");
});

test("every Square request shape is locked to a pinned official SDK operation", () => {
  assert.equal(SQUARE_FIELD_CENSUS.requestContracts.length, SQUARE_READ_STREAMS.length);
  assert.equal(
    new Set(SQUARE_FIELD_CENSUS.requestContracts.map((contract) => contract.streamId)).size,
    SQUARE_READ_STREAMS.length,
  );

  for (const stream of SQUARE_READ_STREAMS) {
    const contract = SQUARE_FIELD_CENSUS.requestContracts.find((candidate) => candidate.streamId === stream.id);
    assert.ok(contract, `${stream.id} has no pinned SDK request contract`);
    assert.equal(contract.method, stream.method);
    assert.equal(
      contract.endpoint.replace(/\{[^}]+\}/g, "{}"),
      stream.endpoint.replace(/\{[^}]+\}/g, "{}"),
      `${stream.id} route shape diverges from the SDK`,
    );
    assert.deepEqual(contract.probe, squareReadRequestContractProbe(stream));
    assert.equal(contract.validation.exactOperationMatch, true);
    assert.equal(contract.validation.queryKeysAccepted, true);

    for (const key of Object.keys(contract.probe.query)) {
      assert.ok(contract.sdkQueryKeys.includes(key), `${stream.id} query key ${key} is absent from the SDK operation`);
    }
    if (stream.method === "POST") {
      assert.ok(contract.sdkRequestSerializer);
      assert.equal(contract.validation.bodyWireRoundTrip, true);
      assert.equal(contract.validation.unknownBodyKeyStripped, true);
    } else {
      assert.equal(contract.sdkRequestSerializer, null);
      assert.equal(contract.validation.bodyWireRoundTrip, null);
      assert.equal(contract.validation.unknownBodyKeyStripped, null);
    }
  }
});

test("SDK census is the exact transitive closure of every selected response entity", () => {
  const expectedRoots = [...new Set(SQUARE_READ_STREAMS.map((stream) => stream.rootEntity))].sort();
  assert.deepEqual([...SQUARE_FIELD_CENSUS.rootEntities], expectedRoots);

  const closure = new Set<string>();
  for (const root of expectedRoots) {
    for (const model of squareTransitiveModels(root)) closure.add(model);
  }
  assert.deepEqual([...closure].sort(), Object.keys(SQUARE_FIELD_CENSUS.models).sort());

  for (const model of Object.values(SQUARE_FIELD_CENSUS.models)) {
    for (const reference of squareCensusReferences(model.shape)) {
      assert.ok(SQUARE_FIELD_CENSUS.models[reference], `${model.name} -> ${reference} is unresolved`);
    }
  }
});

test("high-value retail and cafe fields remain queryable through nested SDK paths", () => {
  const payment = new Set(squareCensusPaths("Payment").map((field) => field.path));
  assert.ok(payment.has("amount_money.amount"));
  assert.ok(payment.has("card_details.card.fingerprint"));
  assert.ok(payment.has("processing_fee[].amount_money.amount"));
  assert.ok(payment.has("tip_money.amount"));

  const order = new Set(squareCensusPaths("Order").map((field) => field.path));
  assert.ok(order.has("line_items[].catalog_object_id"));
  assert.ok(order.has("line_items[].modifiers[].catalog_object_id"));
  assert.ok(order.has("line_items[].applied_taxes[].tax_uid"));
  assert.ok(order.has("fulfillments[].pickup_details.recipient.customer_id"));
  assert.ok(order.has("returns[].return_line_items[].quantity"));

  const coverage = squareStreamFieldCoverage("square_catalog_objects");
  assert.equal(coverage.rootEntity, "CatalogObject");
  assert.equal(coverage.rawEscapeHatch, "immutable_raw_json_and_runtime_field_index");
  assert.ok(coverage.transitiveModels.length > 90);
  assert.ok(coverage.paths.some((field) => field.path === "item_variation_data.sku"));
  assert.ok(coverage.paths.some((field) => field.path === "item_data.variations[]" && field.kind === "cycle"));
});

test("runtime field index preserves additive fields and treats opaque custom values safely", () => {
  const payment = buildSquareRuntimeFieldIndex("Payment", {
    id: "payment-1",
    amount_money: { amount: "1234", currency: "AUD" },
    future_risk_signal: { score: 0.91 },
  });
  assert.equal(payment.rawPayloadPolicy, "immutable_required");
  assert.equal(payment.semanticDisposition, "exploratory_until_reviewed");
  assert.deepEqual(payment.undocumentedPaths, ["future_risk_signal", "future_risk_signal.score"]);
  assert.equal(payment.fields.find((field) => field.path === "amount_money.amount")?.documentedByPinnedSdk, true);

  const custom = buildSquareRuntimeFieldIndex("CustomAttribute", {
    key: "seating_preferences",
    value: { patio: true, "allergen.notes": ["nuts"] },
  });
  assert.deepEqual(custom.undocumentedPaths, []);

  const bounded = buildSquareRuntimeFieldIndex("Payment", { nested: { too: { deep: true } } }, { maxDepth: 1 });
  assert.equal(bounded.truncated, true);
});

test("transport builder places cursor, bounds, locations and fan-out paths deterministically", () => {
  const order = buildSquareReadRequest(squareReadStream("square_orders"), {
    cursor: "next-page",
    pageSize: 500,
    beginTime: "2026-01-01T00:00:00Z",
    endTime: "2026-02-01T00:00:00Z",
    locationIds: ["L1", "L2"],
  });
  assert.equal(order.method, "POST");
  assert.deepEqual(order.query, {});
  assert.equal(order.body?.cursor, "next-page");
  assert.equal(order.body?.limit, 500);
  assert.deepEqual(order.body?.location_ids, ["L1", "L2"]);
  assert.equal(
    ((order.body?.query as Record<string, unknown>).filter as Record<string, unknown>) !== undefined,
    true,
  );

  const payment = buildSquareReadRequest(squareReadStream("square_payments"), {
    cursor: "page-2",
    pageSize: 100,
    beginTime: "2026-01-01T00:00:00Z",
    endTime: "2026-02-01T00:00:00Z",
    locationIds: ["L1"],
  });
  assert.equal(payment.query.cursor, "page-2");
  assert.equal(payment.query.location_id, "L1");
  assert.equal(payment.query.begin_time, "2026-01-01T00:00:00Z");
  assert.equal(payment.body, null);

  const attributes = buildSquareReadRequest(squareReadStream("square_order_custom_attributes"), {
    pathParameters: { order_id: "order / 1" },
  });
  assert.equal(attributes.path, "/v2/orders/order%20%2F%201/custom-attributes");

  assert.throws(
    () => buildSquareReadRequest(squareReadStream("square_orders"), { pageSize: 1_001 }),
    /page size exceeds 1000/u,
  );
  assert.throws(
    () => buildSquareReadRequest(squareReadStream("square_payments"), { pageSize: 0 }),
    /positive safe integer/u,
  );
  assert.throws(
    () => buildSquareReadRequest(squareReadStream("square_invoices"), { locationIds: ["L1", "L2"] }),
    /exactly one location/u,
  );
  assert.throws(
    () => buildSquareReadRequest(squareReadStream("square_order_custom_attributes")),
    /requires path parameter order_id/u,
  );
});
