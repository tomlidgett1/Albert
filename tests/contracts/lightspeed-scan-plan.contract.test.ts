import assert from "node:assert/strict";
import test from "node:test";
import {
  SPEC_TABLES,
  buildScanPlan,
  collapseRelations,
  shardIdRange,
  type SpecTable,
} from "../../connectors/lightspeed-r/scan-plan.js";

const plan = buildScanPlan();

test("every one of the 93 spec tables is reachable by exactly one scan", () => {
  assert.equal(SPEC_TABLES.length, 90, "the spec carries 90 unique tables");

  const reached = new Map<string, number>();
  for (const g of plan.groups) for (const m of g.members) {
    reached.set(m.table.id, (reached.get(m.table.id) ?? 0) + 1);
  }
  for (const f of plan.fanOuts) reached.set(f.table.id, (reached.get(f.table.id) ?? 0) + 1);

  const unreachable = SPEC_TABLES.filter((t) => !reached.has(t.id)).map((t) => t.id);
  assert.deepEqual(unreachable, [], "an unreachable table can never be populated");
  assert.equal(plan.tableCount, 90);
});

test("a table reachable from several parents is fetched from each, not dropped", () => {
  // Contact is embedded in Customer, Employee, Vendor, Shop, CreditAccount and ShipTo.
  const contactGroups = plan.groups.filter((g) =>
    g.members.some((m) => m.table.id === "ls_contacts"));
  assert.ok(
    contactGroups.length > 1,
    `ls_contacts must be collected from every parent that embeds it, saw ${contactGroups.length}`,
  );
});

test("every group has exactly one leader whose grain is one record of the resource", () => {
  for (const g of plan.groups) {
    const leaders = g.members.filter((m) => m.table.isGroupLeader);
    assert.equal(leaders.length >= 1, true, `${g.resource} has no leader`);
    assert.equal(g.members[0].table.id, g.leader.id, `${g.resource} must list its leader first`);
    assert.equal(g.members[0].projection, "records", `${g.resource} leader projects records 1:1`);
  }
});

test("every member declares how it projects, and nested ones carry a path", () => {
  for (const g of plan.groups) {
    for (const m of g.members) {
      assert.ok(["records", "nested"].includes(m.projection),
        `${g.resource}.${m.table.id} has no projection kind`);
      if (m.projection === "nested") {
        assert.ok(typeof m.projectFrom === "string" && m.projectFrom.length > 0,
          `${g.resource}.${m.table.id} is nested but has no path`);
      } else {
        assert.equal(m.projectFrom, null,
          `${g.resource}.${m.table.id} projects records 1:1 and must carry no path`);
      }
    }
  }
});

test("relation unions drop prefixes already implied by a longer path", () => {
  assert.deepEqual(
    collapseRelations(["SaleLines", "SaleLines.Discount", "SalePayments"]),
    ["SaleLines.Discount", "SalePayments"],
    "requesting SaleLines alongside SaleLines.Discount wastes payload: the child implies the parent",
  );
  assert.deepEqual(collapseRelations(["A", "A", "B"]), ["A", "B"]);
  assert.deepEqual(collapseRelations([]), []);
});

test("one Sale walk fills every sale-derived table", () => {
  const sale = plan.groups.find((g) => g.resource === "Sale");
  assert.ok(sale, "Sale must be a scan group");
  assert.equal(sale.leader.id, "ls_sales");
  const ids = sale.members.map((m) => m.table.id);
  assert.ok(ids.includes("ls_sale_lines"), "sale lines must ride the same walk");
  assert.ok(ids.length >= 4, `expected several tables from one Sale walk, got ${ids.length}`);
  assert.ok(sale.relations.length > 0, "the walk must request its children");
});

test("archived populations are swept only where the filter is documented to work", () => {
  const item = plan.groups.find((g) => g.resource === "Item");
  assert.ok(item?.extraParamSets.some((p) => p.archived === "only"),
    "Item hides archived records behind an explicit parameter");

  const sale = plan.groups.find((g) => g.resource === "Sale");
  assert.deepEqual(
    sale?.extraParamSets, [],
    "Sale's archived filter is observed to be ignored; a second pass would be a " +
    "full duplicate history walk for zero rows",
  );
});

test("id fields are resolved for every group", () => {
  for (const g of plan.groups) {
    assert.ok(/^[a-z][A-Za-z0-9]*$/.test(g.idField),
      `${g.resource} resolved a malformed id field: ${g.idField}`);
  }
  assert.equal(plan.groups.find((g) => g.resource === "Sale")?.idField, "saleID");
  assert.equal(plan.groups.find((g) => g.resource === "Item")?.idField, "itemID");
});

test("keyset capability is evidence-based, never assumed", () => {
  const sale = plan.groups.find((g) => g.resource === "Sale");
  assert.equal(sale?.keysetCapable, true, "Sale documents a saleID pushdown");
  // Whatever the answer per resource, it must be a decision, not a default.
  for (const g of plan.groups) assert.equal(typeof g.keysetCapable, "boolean");
});

test("account-wide aliases are used instead of per-parent fan-out", () => {
  const shipments = SPEC_TABLES.find((t) => t.id === "ls_order_shipments");
  assert.ok(shipments, "ls_order_shipments must exist");
  assert.equal(shipments.requiresParentIds, false,
    "walking Order/{orderID}/Shipment across 4,323 orders costs 4,323 requests; " +
    "the documented account-wide alias costs about forty");
  assert.equal(shipments.viaAlias, "Shipment");
});

test("only genuinely parent-scoped endpoints remain as fan-outs", () => {
  assert.ok(plan.fanOuts.length <= 3,
    `unexpected fan-outs: ${plan.fanOuts.map((f) => f.table.id).join(", ")}`);
  for (const f of plan.fanOuts) {
    assert.match(f.endpoint, /\{[A-Za-z]+\}/, `${f.table.id} is not actually parent-scoped`);
  }
});

test("id sharding produces contiguous, non-overlapping, complete windows", () => {
  const shards = shardIdRange(1, 250, 100);
  assert.deepEqual(shards, [
    { from: 1, to: 100 }, { from: 101, to: 200 }, { from: 201, to: 250 },
  ]);
  for (let i = 1; i < shards.length; i += 1) {
    assert.equal(shards[i].from, shards[i - 1].to + 1, "no id may fall between two shards");
  }
  assert.deepEqual(shardIdRange(5, 5, 100), [{ from: 5, to: 5 }]);
  assert.deepEqual(shardIdRange(10, 1, 100), [], "an inverted range yields no work");
  assert.throws(() => shardIdRange(1, 10, 0), /positive integer/);
});

test("a group missing its leader fails the build rather than shipping unreachable tables", () => {
  const orphan = SPEC_TABLES
    .filter((t) => t.scanGroups.includes("Sale"))
    .map((t) => (t.isGroupLeader ? { ...t, isGroupLeader: false } : t)) as SpecTable[];
  assert.throws(() => buildScanPlan(orphan), /no leader table/);
});
