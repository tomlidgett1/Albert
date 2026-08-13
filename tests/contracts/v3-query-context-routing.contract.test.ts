import assert from "node:assert/strict";
import test from "node:test";

import { loadActiveConnectorKeys } from "../../services/control-plane/src/web-repository.js";
import {
  loadConversationModelContext,
  type ConversationSupabase,
} from "../../services/conversation/src/artifact-store.js";

test("v3 model context restores Cube and typed live query namespaces", async () => {
  const supabase = {
    rpc: async (name: string) => {
      assert.equal(name, "albert_model_context");
      return {
        error: null,
        data: [{
          turn_number: 1,
          user_message: "Compare store sales and current Shopify inventory",
          status: "failed",
          assistant_event: {
            type: "answer",
            text: "Here is the comparison.",
            provenance: {
              definitions: [
                {
                  metric: "cube.yaml:sales_overview",
                  label: "Store sales",
                  definition: "measures:\n  - sales.gross_takings\n",
                },
                {
                  metric: "shopifyql.ir:sales",
                  label: "Live Shopify sales",
                  definition: "FROM sales\nSHOW net_sales\n",
                },
                {
                  metric: "shopify-admin.ir:inventory-items",
                  label: "Live Shopify inventory",
                  definition: "resource: inventory-items\nlimit: 20\n",
                },
                {
                  metric: "untrusted.definition:ignored",
                  label: "Ignored",
                  definition: "must not enter model context",
                },
              ],
            },
          },
        }],
      };
    },
  } as unknown as ConversationSupabase;

  const messages = await loadConversationModelContext("conversation_test", supabase);
  assert.deepEqual(messages[1]?.governedQueries?.map(({ view }) => view), [
    "sales_overview",
    "shopifyql:sales",
    "shopify-admin:inventory-items",
  ]);
});

test("active connector routing is authenticated, bounded, stable, and deduplicated", async () => {
  const calls: string[] = [];
  const supabase = {
    rpc: async (name: string) => {
      calls.push(name);
      return {
        error: null,
        data: {
          connections: [
            { connector_key: "xero", status: "degraded" },
            { connector_key: "shopify", status: "connected" },
            { connector_key: "lightspeed-r", status: "blocked" },
            { connector_key: "shopify", status: "connected" },
            { connector_key: "square", status: "pending" },
            { connector_key: "deputy", status: "disconnected" },
          ],
        },
      };
    },
  } as unknown as Parameters<typeof loadActiveConnectorKeys>[0];

  assert.deepEqual(await loadActiveConnectorKeys(supabase), [
    "lightspeed-r",
    "shopify",
    "xero",
  ]);
  // The workspace read plus the stream-cursor freshness fallback (readiness empty).
  assert.deepEqual(calls, ["albert_connections_workspace", "albert_connector_freshness"]);
});

test("active connector routing rejects malformed or failed control-plane state", async () => {
  const failing = {
    rpc: async () => ({ data: null, error: { message: "unavailable" } }),
  } as unknown as Parameters<typeof loadActiveConnectorKeys>[0];
  await assert.rejects(loadActiveConnectorKeys(failing), /routing state could not be loaded/iu);

  const malformed = {
    rpc: async () => ({ data: { connections: [{ connector_key: "xero", status: "invented" }] }, error: null }),
  } as unknown as Parameters<typeof loadActiveConnectorKeys>[0];
  await assert.rejects(loadActiveConnectorKeys(malformed), /returned invalid data/iu);
});
