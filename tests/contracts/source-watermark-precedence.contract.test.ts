import assert from "node:assert/strict";
import test from "node:test";
import { PostgresTenantSemanticContextProvider } from "../../services/semantic-query/src/postgres-adapters.js";

/**
 * quality.pipeline_stats emits one watermark row per domain and every domain of
 * a connector repeats the same connection id. The dogfood tenant had a product
 * catalogue that last synced in 2021 alongside sales that synced minutes ago,
 * and the stale domain won purely because "products" sorts after "inventory",
 * which made the runtime report five-year-old sales and refuse to answer.
 */
const TENANT = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CONNECTION = "01KZ54B1PCKM1MHSNHY4XT6DEX";

function contextProvider(capabilityRows: readonly unknown[], statsRows: readonly unknown[]) {
  const controlPlanePool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("tenant_overlays")) {
          return { rows: [{ version: "1", overlay: { timezone: "Australia/Melbourne" }, dossier: {} }] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    }),
  };
  const analyticalDatabase = {
    queryAsSemanticRole: async (request: { sql: string }) => {
      if (request.sql.includes("active_tenant_capability")) return { rows: [...capabilityRows] };
      if (request.sql.includes("quality.pipeline_stats")) return { rows: [...statsRows] };
      return { rows: [] };
    },
  };
  return new PostgresTenantSemanticContextProvider(
    controlPlanePool as never,
    analyticalDatabase as never,
  );
}

const CAPABILITY_ROW = {
  capability: "commerce.order_lines",
  connection_id: CONNECTION,
  connector_id: "lightspeed-r",
  available: true,
  support: "full",
  reason_code: "required_scopes_granted",
  reason_detail: null,
  coverage: {},
  pack_version: "1.0.0",
};

test("a stale domain watermark cannot overwrite a fresher one for the same connection", async () => {
  const provider = contextProvider(
    [{ ...CAPABILITY_ROW, source_watermark: "2026-08-05T02:35:00.124Z" }],
    // Returned in the query's domain order; "products" sorts last among the
    // domains carrying a value, and "sales" carries null.
    [
      { domain: "canonical", source_watermarks: { [CONNECTION]: "2026-08-04T23:00:35+00:00" } },
      { domain: "customers", source_watermarks: { [CONNECTION]: "2026-08-05T01:36:21.000Z" } },
      { domain: "inventory", source_watermarks: { [CONNECTION]: "2026-08-01T01:50:39.000Z" } },
      { domain: "products", source_watermarks: { [CONNECTION]: "2021-06-22T03:20:14.000Z" } },
      { domain: "sales", source_watermarks: { [CONNECTION]: null } },
    ],
  );

  const context = await provider.load({
    tenantId: TENANT, conversationId: "01KZ7V7EAVPV3YNKXH1QDEXAV5",
    turnId: "01KZ7V7EFWA7M0TGM3SMWY3YRC", role: "owner",
  } as never);

  assert.equal(context.sourceWatermarks[CONNECTION], "2026-08-05T02:35:00.124Z");
});

test("the freshest watermark wins regardless of which source reports it", async () => {
  const provider = contextProvider(
    [{ ...CAPABILITY_ROW, source_watermark: "2021-06-22T03:20:14.000Z" }],
    [{ domain: "sales", source_watermarks: { [CONNECTION]: "2026-08-05T01:36:21.000Z" } }],
  );

  const context = await provider.load({
    tenantId: TENANT, conversationId: "01KZ7V7EAVPV3YNKXH1QDEXAV5",
    turnId: "01KZ7V7EFWA7M0TGM3SMWY3YRC", role: "owner",
  } as never);

  assert.equal(context.sourceWatermarks[CONNECTION], "2026-08-05T01:36:21.000Z");
});

test("unparseable watermark values never displace a real one", async () => {
  const provider = contextProvider(
    [{ ...CAPABILITY_ROW, source_watermark: "2026-08-05T02:35:00.124Z" }],
    [{ domain: "sales", source_watermarks: { [CONNECTION]: "not-a-timestamp" } }],
  );

  const context = await provider.load({
    tenantId: TENANT, conversationId: "01KZ7V7EAVPV3YNKXH1QDEXAV5",
    turnId: "01KZ7V7EFWA7M0TGM3SMWY3YRC", role: "owner",
  } as never);

  assert.equal(context.sourceWatermarks[CONNECTION], "2026-08-05T02:35:00.124Z");
});
