import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LIGHTSPEED_STREAMS } from "../../connectors/lightspeed-r/streams.js";
import {
  nextPass,
  pageParams,
  projectStreamRows,
  resolveStreamScan,
  syncStreamPage,
} from "../../connectors/lightspeed-r/spec-sync.js";

const hash = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload) ?? "null").digest("hex");
const stream = (id: string) => LIGHTSPEED_STREAMS.find((s) => s.id === id)!;

test("every one of the 90 streams resolves a scan without special-casing", () => {
  assert.equal(LIGHTSPEED_STREAMS.length, 90);
  for (const s of LIGHTSPEED_STREAMS) {
    const scan = resolveStreamScan(s);
    assert.ok(scan.group.path.endsWith(".json"), `${s.id} resolved a malformed path`);
    assert.equal(scan.table.id, s.id);
    if (s.projection === "nested") {
      assert.ok(scan.projectFrom, `${s.id} is nested but resolved no projection path`);
    }
  }
});

test("every member of a group requests the identical relation union, so one walk serves all", () => {
  const sales = resolveStreamScan(stream("ls_sales"));
  assert.equal(sales.projectFrom, null);
  const lines = resolveStreamScan(stream("ls_sale_lines"));
  assert.ok(lines.projectFrom, "sale lines must project from a path");
  assert.ok(
    lines.relations.some((r) => r.startsWith("SaleLines")),
    `sale lines must request its own relation, got ${lines.relations.join(",")}`,
  );
  // Identical parameters are what make the connector's page cache serve six
  // sale-derived streams from one Sale.json walk: the HTTP count is what the
  // one-drip-per-second budget constrains, and a narrowed per-member set
  // would make every member's walk a cache miss.
  assert.deepEqual([...lines.relations], [...sales.relations],
    "group members must request byte-identical relation sets");
  const payments = resolveStreamScan(stream("ls_sale_payments"));
  assert.deepEqual([...payments.relations], [...sales.relations]);
});

test("a first page sorts by ascending id; a continuation sends only the token", () => {
  const scan = resolveStreamScan(stream("ls_sales"));
  const first = pageParams(scan, {});
  assert.equal(first.sort, "saleID");
  assert.equal(first.limit, "100");

  const next = pageParams(scan, { after: "WzEwMF0=" });
  assert.equal(next.after, "WzEwMF0=");
  assert.equal(next.sort, undefined, "re-sending sort restarts the walk");
  assert.equal(next.limit, undefined);
});

test("hidden populations are separate passes, not a widened first pass", () => {
  const items = resolveStreamScan(stream("ls_items"));
  assert.ok(items.extraParamSets.length > 0, "Item hides archived records");

  const base = pageParams(items, {});
  assert.equal(base.archived, undefined, "the default pass must not be widened");

  const archived = pageParams(items, { pass: 0 });
  assert.equal(archived.archived, "only", "the second pass sweeps archived records only");

  assert.equal(nextPass(items, -1), 0, "the default pass is followed by the first extra");
  assert.equal(nextPass(items, 0), null, "there is nothing after the last extra");

  const sales = resolveStreamScan(stream("ls_sales"));
  assert.equal(nextPass(sales, -1), null,
    "Sale's archived filter is ignored by the vendor, so a second pass would be wasted");
});

test("a nested stream projects one row per array element, not one per parent", () => {
  const scan = resolveStreamScan(stream("ls_sale_lines"));
  const rows = projectStreamRows(scan, [
    { saleID: 101, SaleLines: { SaleLine: [{ saleLineID: 1 }, { saleLineID: 2 }] } },
    { saleID: 102, SaleLines: { SaleLine: { saleLineID: 3 } } },
  ], hash);
  assert.equal(rows.length, 3, "two lines plus one singular child");
  // The child's OWN resource, never the parent's: rows are recorded and
  // referenced by (sourceObjectType, sourceRecordId), so keeping "Sale" here
  // would conflate Sale 5 with SaleLine 5. The stream contract's resource is
  // derived the same way, which is what the canonical guard asserts against.
  assert.ok(rows.every((r) => r.sourceObjectType === "SaleLine"),
    "source_object_type is the child's own vendor resource");
  assert.deepEqual(rows.map((r) => r.sourceRecordId), ["1", "2", "3"]);
  assert.ok(rows.every((r) => r.normalized?.fields), "staging needs a typed projection");
});

test("projection is deterministic so a retry cannot duplicate rows", () => {
  const scan = resolveStreamScan(stream("ls_sale_lines"));
  const page = [{ saleID: 7, SaleLines: { SaleLine: [{ saleLineID: 70 }, { saleLineID: 71 }] } }];
  const a = projectStreamRows(scan, page, hash);
  const b = projectStreamRows(scan, page, hash);
  assert.deepEqual(a.map((r) => r.sourceRecordId), b.map((r) => r.sourceRecordId));
  assert.deepEqual(a.map((r) => r.payloadHash), b.map((r) => r.payloadHash));
});

test("a full walk pages, then sweeps the hidden population, then completes", async () => {
  const target = stream("ls_items");
  const calls: Array<Record<string, string>> = [];
  const pages: unknown[] = [
    { "@attributes": { next: "https://x/Item.json?after=P2" }, Item: [{ itemID: 1 }] },
    { "@attributes": {}, Item: [{ itemID: 2 }] },
    { "@attributes": {}, Item: [{ itemID: 3, archived: true }] },
  ];
  let index = 0;
  const fetchPage = async (_path: string, params: Record<string, string>) => {
    calls.push({ ...params });
    return pages[index++];
  };

  let cursor = undefined as undefined | NonNullable<Awaited<ReturnType<typeof syncStreamPage>>["nextCursor"]>;
  const seen: string[] = [];
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await syncStreamPage({
      stream: target, connectorId: "lightspeed-r", mode: "initial",
      cursor: cursor ?? undefined, fetchPage, hash,
    });
    seen.push(...page.records.map((r) => r.sourceRecordId));
    if (!page.hasMore) {
      assert.ok(page.coverage, "a completed walk must publish coverage evidence");
      assert.equal(page.coverage?.verification, "exhaustive_vendor_scan");
      break;
    }
    cursor = page.nextCursor ?? undefined;
  }

  assert.deepEqual(seen, ["1", "2", "3"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].archived, undefined, "first pass is the default population");
  assert.equal(calls[1].after, "P2", "the second call continues the same population");
  assert.equal(calls[2].archived, "only", "the third call sweeps archived records");
});

test("a repeating continuation blocks the stream instead of looping forever", async () => {
  const target = stream("ls_sales");
  const fetchPage = async () => ({
    "@attributes": { next: "https://x/Sale.json?after=SAME" },
    Sale: [{ saleID: 1, SaleLines: {}, SalePayments: {} }],
  });
  const first = await syncStreamPage({
    stream: target, connectorId: "lightspeed-r", mode: "initial", fetchPage, hash,
  });
  const second = await syncStreamPage({
    stream: target, connectorId: "lightspeed-r", mode: "initial",
    cursor: first.nextCursor ?? undefined, fetchPage, hash,
  });
  assert.equal(second.paginationBlock?.code, "pagination_not_advancing");
  assert.equal(second.nextCursor, null, "a blocked page must not commit a cursor");
  assert.equal(second.hasMore, false);
});

test("a silently relation-free page is rejected rather than staged empty", async () => {
  const target = stream("ls_sale_lines");
  const fetchPage = async () => ({ "@attributes": {}, Sale: [{ saleID: 1 }, { saleID: 2 }] });
  await assert.rejects(
    syncStreamPage({ stream: target, connectorId: "lightspeed-r", mode: "initial", fetchPage, hash }),
    /Relations absent from every record/,
  );
});

test("every stream can complete an empty walk without throwing", async () => {
  const fetchPage = async (_path: string, _params: Record<string, string>) => ({ "@attributes": {} });
  for (const s of LIGHTSPEED_STREAMS) {
    const page = await syncStreamPage({
      stream: s, connectorId: "lightspeed-r", mode: "initial", fetchPage, hash,
    });
    assert.deepEqual(page.records, [], `${s.id} invented rows from an empty page`);
    assert.equal(typeof page.hasMore, "boolean");
  }
});
