import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildScanPlan } from "../../connectors/lightspeed-r/scan-plan.js";
import {
  afterTokenFrom,
  assertRelationsPresent,
  buildBoundRequest,
  buildPageRequest,
  evaluatePagination,
  parseEnvelope,
  projectPage,
  readSourceUpdatedAt,
  resolvePath,
} from "../../connectors/lightspeed-r/fetch-core.js";

const plan = buildScanPlan();
const sale = plan.groups.find((g) => g.resource === "Sale")!;
const hash = (input: string) => createHash("sha256").update(input).digest("hex");

test("a first page sorts ascending by primary id and bounds the window", () => {
  const req = buildPageRequest(sale, { window: { from: 1, to: 5000 } });
  assert.equal(req.path, "Sale.json");
  assert.equal(req.params.sort, "saleID", "ascending id is the only insert-safe order");
  assert.equal(req.params.saleID, "><,1,5000");
  assert.equal(req.params.limit, "100", "R-Series caps page size at 100");
  assert.ok(req.params.load_relations, "children must ride the same request");
});

test("a continuation sends only the token, never the filter or sort again", () => {
  const req = buildPageRequest(sale, { window: { from: 1, to: 5000 }, after: "WzEwMF0=" });
  assert.equal(req.params.after, "WzEwMF0=");
  assert.equal(req.params.sort, undefined, "re-sending sort alongside a token restarts the walk");
  assert.equal(req.params.saleID, undefined, "the id filter is already baked into the token");
  assert.equal(req.params.limit, undefined);
  assert.ok(req.params.load_relations, "relations must survive onto continuation pages");
});

test("page size is clamped to the vendor maximum", () => {
  assert.equal(buildPageRequest(sale, { pageSize: 5000 }).params.limit, "100");
  assert.equal(buildPageRequest(sale, { pageSize: 25 }).params.limit, "25");
});

test("id bounds are discovered with a sorted single row, not a count", () => {
  const max = buildBoundRequest(sale, "max");
  assert.equal(max.params.sort, "-saleID");
  assert.equal(max.params.limit, "1");
  assert.equal(max.params.count, undefined, "count=1 costs ten rate units; a sorted row costs one");
  assert.equal(buildBoundRequest(sale, "min").params.sort, "saleID");
});

test("extra parameter sets reach the request so hidden populations are swept", () => {
  const req = buildPageRequest(sale, { extraParams: { archived: "only" } });
  assert.equal(req.params.archived, "only");
});

test("the envelope is parsed, including the single-result object form", () => {
  const many = parseEnvelope(
    { "@attributes": { count: "2", next: "https://x/Sale.json?after=WzJd" }, Sale: [{ saleID: 1 }, { saleID: 2 }] },
    "Sale",
  );
  assert.equal(many.records.length, 2);
  assert.equal(many.reportedCount, 2);
  assert.equal(afterTokenFrom(many.nextUrl), "WzJd");

  const one = parseEnvelope({ "@attributes": { count: "1" }, Sale: { saleID: 7 } }, "Sale");
  assert.equal(one.records.length, 1, "a single result arrives as an object, not an array");

  const empty = parseEnvelope({ "@attributes": { count: "0" } }, "Sale");
  assert.deepEqual(empty.records, []);
  assert.equal(empty.nextUrl, null);

  assert.throws(() => parseEnvelope("not json", "Sale"), /not a JSON object/);
});

test("nested paths resolve through R-Series singular wrappers", () => {
  const record = { SaleLines: { SaleLine: [{ saleLineID: 1 }, { saleLineID: 2 }] } };
  assert.equal(resolvePath(record, "SaleLines.SaleLine").length, 2);
  // A single child is returned as an object; it must still project as one row.
  assert.equal(resolvePath({ SaleLines: { SaleLine: { saleLineID: 9 } } }, "SaleLines.SaleLine").length, 1);
  assert.deepEqual(resolvePath({}, "SaleLines.SaleLine"), []);
  assert.deepEqual(resolvePath({ SaleLines: null }, "SaleLines.SaleLine"), []);
});

test("one page fills the leader and every nested table in the group", () => {
  const page = {
    records: [
      {
        saleID: 101,
        timeStamp: "2026-08-01T02:03:04+00:00",
        SaleLines: { SaleLine: [{ saleLineID: 1 }, { saleLineID: 2 }] },
        SalePayments: { SalePayment: [{ salePaymentID: 55 }] },
      },
    ],
    nextUrl: null,
    reportedCount: 1,
  };
  const records = projectPage(sale, page, hash);
  const byTable = new Map<string, number>();
  for (const r of records) byTable.set(r.sourceObjectType, (byTable.get(r.sourceObjectType) ?? 0) + 1);

  assert.equal(byTable.get("ls_sales"), 1, "one sale row");
  assert.equal(byTable.get("ls_sale_lines"), 2, "one row per line, not one per sale");
  assert.ok(records.every((r) => r.payloadHash.length === 64), "every record carries a content hash");
  assert.ok(records.every((r) => r.sourceRecordId.length > 0), "every record is addressable");
});

test("child rows are keyed so re-running a window is idempotent", () => {
  const page = {
    records: [{ saleID: 500, SaleLines: { SaleLine: [{ saleLineID: 11 }, { saleLineID: 12 }] } }],
    nextUrl: null, reportedCount: 1,
  };
  const first = projectPage(sale, page, hash);
  const second = projectPage(sale, page, hash);
  assert.deepEqual(
    first.map((r) => `${r.sourceObjectType}/${r.sourceRecordId}`),
    second.map((r) => `${r.sourceObjectType}/${r.sourceRecordId}`),
    "identical input must produce identical keys or a retry duplicates rows",
  );
  assert.deepEqual(first.map((r) => r.payloadHash), second.map((r) => r.payloadHash));
});

test("a silently relation-free response is rejected, not committed", () => {
  // The dangerous case: the walk succeeds, but every child table stages zero rows.
  assert.throws(
    () => assertRelationsPresent(sale, [{ saleID: 1 }, { saleID: 2 }]),
    /Relations absent from every record/,
    "an empty child table is worse than a loud failure",
  );
  // Only the keys nested members actually project from are required. A relation
  // that belongs to a child level (Item hangs off a SaleLine) is not asserted on
  // the parent, or every valid page would be rejected.
  const requiredKeys = [
    ...new Set(
      sale.members
        .filter((m) => m.projection === "nested" && m.projectFrom)
        .map((m) => m.projectFrom!.split(".")[0]),
    ),
  ];
  const complete: Record<string, unknown> = { saleID: 1 };
  for (const key of requiredKeys) complete[key] = {};
  assert.doesNotThrow(() => assertRelationsPresent(sale, [complete]),
    `a record carrying ${requiredKeys.join(", ")} must be accepted`);

  assert.doesNotThrow(() => assertRelationsPresent(sale, []), "an empty page asserts nothing");

  // The error must name the table that would have been emptied, not just the key.
  try {
    assertRelationsPresent(sale, [{ saleID: 1 }]);
    assert.fail("expected a rejection");
  } catch (error) {
    assert.match(String((error as Error).message), /would stage zero rows/);
  }
});

test("source modification time is read from the documented fields", () => {
  assert.equal(readSourceUpdatedAt({ timeStamp: "2026-08-01T02:03:04+00:00" }), "2026-08-01T02:03:04.000Z");
  assert.equal(readSourceUpdatedAt({ updateTime: "2026-08-02T00:00:00+00:00" }), "2026-08-02T00:00:00.000Z");
  assert.equal(readSourceUpdatedAt({ nothing: "here" }), null);
  assert.equal(readSourceUpdatedAt({ timeStamp: "gibberish" }), null);
});

test("a repeating continuation token blocks instead of looping forever", () => {
  const repeat = evaluatePagination("TOKEN_A", "https://x/Sale.json?after=TOKEN_A", 100);
  assert.equal(repeat.nextAfter, null);
  assert.equal(repeat.block?.code, "pagination_not_advancing");

  const unreadable = evaluatePagination(null, "https://x/Sale.json?limit=100", 100);
  assert.equal(unreadable.block?.code, "pagination_identity_invalid");

  const good = evaluatePagination("TOKEN_A", "https://x/Sale.json?after=TOKEN_B", 100);
  assert.equal(good.nextAfter, "TOKEN_B");
  assert.equal(good.block, null);

  const terminal = evaluatePagination("TOKEN_A", null, 42);
  assert.equal(terminal.nextAfter, null);
  assert.equal(terminal.block, null, "a terminal page is not a failure");
});

test("every scan group can build a valid first request", () => {
  for (const g of plan.groups) {
    const req = buildPageRequest(g, { window: { from: 1, to: 100 } });
    assert.ok(req.path.endsWith(".json"), `${g.resource} produced a malformed path`);
    assert.equal(req.params.limit, "100");
    assert.ok(req.params.sort, `${g.resource} must request a deterministic order`);
  }
});
