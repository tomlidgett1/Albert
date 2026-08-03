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
