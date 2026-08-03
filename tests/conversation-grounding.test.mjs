import assert from "node:assert/strict";
import { test } from "node:test";
import { findUngroundedNumbers } from "../services/conversation/src/grounding.ts";

test("numeric grounding accepts result figures and server-derived row counts", () => {
  const rows = [
    { category: "Bikes", sales: 84240, margin: 38.4 },
    { category: "Workshop", sales: 31640, margin: 61.7 },
  ];
  assert.deepEqual(
    findUngroundedNumbers("Bikes returned $84,240 and a 38.4% margin across 2 rows.", rows),
    [],
  );
});

test("numeric grounding blocks a model-authored figure", () => {
  const rows = [{ category: "Bikes", sales: 84240 }];
  assert.deepEqual(findUngroundedNumbers("Sales were $84,241.", rows), ["$84,241"]);
});

test("numeric grounding blocks spelled-out figures and unsupported multipliers", () => {
  const rows = [{ category: "Bikes", sales: 84240 }];
  assert.deepEqual(findUngroundedNumbers("Three categories improved.", rows), ["Three"]);
  assert.deepEqual(findUngroundedNumbers("Sales were twice last month.", rows), ["twice"]);
  assert.deepEqual(findUngroundedNumbers("The shortfall was cut in half.", rows), ["cut in half"]);
});

test("numeric grounding accepts governed word values and legitimate copied labels", () => {
  const rows = [
    { category: "Three Bags Full", locations: 3, ratio: 2 },
    { category: "Workshop", locations: 7, ratio: 1 },
    { category: "Bikes", locations: 9, ratio: 1 },
  ];
  assert.deepEqual(
    findUngroundedNumbers("Three Bags Full led three locations and was twice the comparison value.", rows),
    [],
  );
  assert.deepEqual(
    findUngroundedNumbers("The first half of the year was stronger across three rows.", rows),
    [],
  );
});

test("follow-up wording is subject to the same quantitative grounding gate", () => {
  const rows = [{ category: "Bikes", sales: 84240 }];
  assert.deepEqual(findUngroundedNumbers("Show the top ten products next.", rows), ["ten"]);
  assert.deepEqual(findUngroundedNumbers("Compare with last month.", rows), []);
});
