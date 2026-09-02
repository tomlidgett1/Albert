import assert from "node:assert/strict";
import { test } from "node:test";
import type { CubeCatalogue } from "../../packages/albert-v3/src/cube/types.js";
import {
  lookupTopicModel,
  renderTopicIndex,
  searchModelFields,
} from "../../packages/albert-omni/src/semantic-model.js";

// A catalogue in the shape Cube meta produces: every view and member carries
// both a factual description and model-facing guidance (meta.ai_context).
const catalogue = {
  cubes: [],
  views: [
    {
      name: "inventory_analytics",
      title: "Inventory analytics",
      description: "The stock surface: current stock on hand and value per item and store.",
      aiContext: "Dead stock = in_stock plus unsold_180_days; never present stock_age_band as no sales.",
      members: [
        {
          name: "inventory_analytics.stock_age_band",
          kind: "dimension",
          type: "string",
          title: "Stock age band",
          shortTitle: "Stock age band",
          description: "Age band based on days since stock last came in.",
          aiContext: "Receipt age, not sales recency.",
        },
        {
          name: "inventory_analytics.stock_value",
          kind: "measure",
          type: "number",
          title: "Stock value (at cost)",
          shortTitle: "Stock value",
          description: "On-hand units times unit cost.",
        },
        {
          name: "inventory_analytics.unsold_180_days",
          kind: "segment",
          title: "Unsold 180 days",
          shortTitle: "Unsold 180 days",
          description: "Positions whose item has not sold in 180 days.",
        },
      ],
    },
    {
      name: "sales_analytics",
      title: "Sales analytics",
      description: "Completed sales at ticket grain.",
      aiContext: "Use this view for takings, transactions and refunds.",
      members: [
        {
          name: "sales_analytics.gross_takings",
          kind: "measure",
          type: "number",
          title: "Gross takings",
          shortTitle: "Takings",
          description: "Tax-inclusive takings on completed sales.",
        },
      ],
    },
  ],
} as unknown as CubeCatalogue;

test("topic lookup renders the view guidance and member guidance beside their descriptions", () => {
  const result = lookupTopicModel(catalogue, "Inventory analytics");
  // Values with YAML-significant characters render single-quoted.
  assert.match(result.document, /description: '?The stock surface/u);
  assert.match(result.document, /guidance: '?Dead stock = in_stock plus unsold_180_days/u);
  assert.match(result.document, /description: '?Age band based on days since stock last came in\./u);
  assert.match(result.document, /guidance: '?Receipt age, not sales recency\./u);
  // A member without guidance renders no guidance line at all.
  const stockValueBlock = result.document.split("inventory_analytics.stock_value")[1]?.split("- name:")[0] ?? "";
  assert.doesNotMatch(stockValueBlock, /guidance:/u);
  assert.deepEqual([...result.viewNames], ["inventory_analytics"]);
});

test("field search reports every view whose definitions it returned", () => {
  const acrossModel = searchModelFields(catalogue, "stock");
  assert.deepEqual([...acrossModel.viewNames], ["inventory_analytics"]);
  const scoped = searchModelFields(catalogue, "takings", "sales_analytics");
  assert.deepEqual([...scoped.viewNames], ["sales_analytics"]);
  assert.match(scoped.document, /guidance: '?Use this view for takings/u);
  const nothing = searchModelFields(catalogue, "zzz-no-such-field");
  assert.deepEqual([...nothing.viewNames], []);
});

test("the topic index carries the opening of each view's guidance as a routing hint", () => {
  const index = renderTopicIndex(catalogue);
  assert.match(index, /inventory_analytics \("Inventory analytics"\): 1 measures, 1 dimensions\. The stock surface/u);
  assert.match(index, /Guidance: Dead stock = in_stock plus unsold_180_days/u);
  assert.match(index, /Guidance: Use this view for takings, transactions and refunds\./u);
  assert.ok(index.length < 2_000, "the index stays compact: guidance is a routing excerpt, not the full text");
});
