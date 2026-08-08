import assert from "node:assert/strict";
import { test } from "node:test";

import { semanticToolInputSchemas } from "../../packages/agent/src/semantic-tools.js";
import {
  buildDescriptionMatchSql,
  buildItemResolveSql,
  candidatesFromResolveRows,
  chooseNamedEntityAssumption,
  expandToken,
  nameContainsForm,
  tokenizeBusinessPhrase,
} from "../../services/conversation/src/resolve-named-entity.js";

test("gen services expands into general+service match groups", () => {
  assert.deepEqual(tokenizeBusinessPhrase("how many gen services sold this month"), ["gen", "services"]);
  assert.deepEqual(expandToken("gen"), ["general", "gen", "generation"]);
  assert.deepEqual(expandToken("services"), ["service", "services"]);
  const match = buildDescriptionMatchSql("gen services");
  assert.match(match.sql, /general/u);
  assert.match(match.sql, /service/u);
  assert.match(match.sql, / AND /u);
});

test("resolve SQL ranks Lightspeed items on staging sales", () => {
  const sql = buildItemResolveSql("gen services");
  assert.match(sql, /source_lightspeed\.ls_items/u);
  assert.match(sql, /units_this_month/u);
  assert.match(sql, /completed = true/u);
  assert.match(sql, /ILIKE/u);
  assert.ok(!sql.includes("mart."));
});

test("volume leader becomes a high-confidence suggestion, not a forced route", () => {
  const resolution = chooseNamedEntityAssumption("gen services", [
    {
      itemId: "9",
      itemName: "Service - General Service",
      unitsThisMonth: 42,
      unitsAllTime: 900,
    },
    {
      itemId: "99",
      itemName: "Pro Service",
      unitsThisMonth: 1,
      unitsAllTime: 10,
    },
  ]);
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.assumption?.itemId, "9");
  assert.match(resolution.nextStep, /Suggested reading: item_id 9/u);
  assert.match(resolution.nextStep, /category|aggregate/iu);
  assert.match(resolution.reason, /General Service/u);
});

test("many peer SKUs stay ambiguous so the model must choose grain", () => {
  assert.ok(expandToken("glasses").includes("sunglasses"));
  assert.equal(nameContainsForm("scvcn photocromatic sunglasses", "glasses"), false);
  assert.equal(nameContainsForm("technium glasses metallic black", "glasses"), true);

  const resolution = chooseNamedEntityAssumption("glasses", [
    {
      itemId: "16773",
      itemName: "SCVCN Photocromatic sunglasses",
      unitsThisMonth: 0,
      unitsAllTime: 20,
    },
    {
      itemId: "11167",
      itemName: "Tifosi Intense, Matte Gunmetal Single Lens Sunglasses - Clear Lenses",
      unitsThisMonth: 0,
      unitsAllTime: 20,
    },
    {
      itemId: "11172",
      itemName: "Tifosi Vero, Carbon Fototec Sunglasses - Light Night Fototec",
      unitsThisMonth: 0,
      unitsAllTime: 16,
    },
    {
      itemId: "12193",
      itemName: "Technium Glasses, Metalic Black, Orange Blue Mirror Lens",
      unitsThisMonth: 0,
      unitsAllTime: 5,
    },
  ]);
  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.assumption, null);
  assert.match(resolution.nextStep, /ls_categories/u);
  assert.match(resolution.nextStep, /Do not count only the top item_id/u);
  assert.ok(!/Proceed with item_id 16773/u.test(resolution.nextStep));
});

test("empty catalogue match stays none", () => {
  const resolution = chooseNamedEntityAssumption("zzzz", []);
  assert.equal(resolution.confidence, "none");
  assert.equal(resolution.assumption, null);
  assert.match(resolution.nextStep, /ls_categories/u);
});

test("resolve rows coerce numeric sales cells", () => {
  const candidates = candidatesFromResolveRows([
    { item_id: "9", item_name: "Service - General Service", units_this_month: "6.0000", units_all_time: "100" },
  ]);
  assert.equal(candidates[0]?.unitsThisMonth, 6);
  assert.equal(candidates[0]?.unitsAllTime, 100);
});

test("resolve_named_entity tool input is local and strict", () => {
  const parsed = semanticToolInputSchemas.resolve_named_entity.parse({
    phrase: "gen services",
  });
  assert.equal(parsed.phrase, "gen services");
  assert.match(parsed.purpose, /Match/u);
});
