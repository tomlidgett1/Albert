import assert from "node:assert/strict";
import test from "node:test";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.ts";
import {
  assertCubeBearerScope,
  CubeBearerClient,
} from "../../packages/albert-codex/src/cube-bearer-client.ts";

const scope = {
  tenantId: "01J00000000000000000000001",
  conversationId: "01J00000000000000000000002",
  turnId: "01J00000000000000000000003",
  role: "owner",
} as const;

function bearer(): string {
  return signCubeJwt({
    secret: "s".repeat(48),
    expiresInSeconds: 900,
    securityContext: {
      tenant_id: scope.tenantId,
      role: scope.role,
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: scope.conversationId,
      turn_id: scope.turnId,
    },
  });
}

test("Codex Cube bearer is bound to the exact tenant, role, conversation and turn", () => {
  const token = bearer();
  assert.doesNotThrow(() => assertCubeBearerScope(token, scope));
  assert.throws(() => assertCubeBearerScope(token, { ...scope, turnId: "01J00000000000000000000004" }), /not scoped/u);
  assert.throws(() => assertCubeBearerScope(token, { ...scope, tenantId: "01J00000000000000000000005" }), /not scoped/u);
});

test("bearer client sends the opaque token and retains Cube semantic validation", async () => {
  const token = bearer();
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    requests.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), token);
    if (url.pathname.endsWith("/meta")) {
      return Response.json({
        cubes: [{
          name: "sales_analytics",
          title: "Sales analytics",
          public: true,
          measures: [{
            name: "sales_analytics.net_sales",
            title: "Net sales",
            shortTitle: "Net sales",
            type: "number",
            aliasMember: "sales.net_sales",
          }],
          dimensions: [],
          segments: [],
        }],
      });
    }
    return Response.json({
      data: [{ "sales_analytics.net_sales": 123.45 }],
      annotation: {
        measures: {
          "sales_analytics.net_sales": {
            title: "Net sales", shortTitle: "Net sales", type: "number", format: "currency",
          },
        },
      },
    });
  };
  const client = new CubeBearerClient({ apiUrl: "https://cube.example.test", bearer: token, fetcher });
  const loaded = await client.loadQuery({ measures: ["sales_analytics.net_sales"], limit: 1 });
  assert.equal(loaded.result.ok, true);
  if (loaded.result.ok) assert.equal(loaded.result.rows[0]?.["sales_analytics.net_sales"], 123.45);
  const rejected = await client.loadQuery({ measures: ["unknown_view.value"] });
  assert.equal(rejected.result.ok, false);
  assert.equal(requests.filter((url) => url.pathname.endsWith("/load")).length, 1);
});
