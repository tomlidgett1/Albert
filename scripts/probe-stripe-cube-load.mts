/**
 * Mint a short control-plane turn lease and load Stripe payments from
 * production Cube. Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/probe-stripe-cube-load.mts
 */
import pg from "pg";
import { ulid } from "ulid";

import { signCubeJwt } from "../packages/albert-v3/src/cube/jwt.js";

const TENANT_ID = "01KZN20VTX2EWW1TQ2AA3MCPW6";
const ACTOR_ID = "e6a1b354-ffbc-41c0-8131-d2f018dba818";

function leaseDbUrl(): string {
  const raw = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL
    ?? process.env.CONTROL_PLANE_DATABASE_URL;
  if (!raw) throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL is required.");
  const url = new URL(raw);
  const ref = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1];
  if (ref) {
    url.username = `${decodeURIComponent(url.username)}.${ref}`;
    url.hostname = "aws-0-ap-southeast-2.pooler.supabase.com";
  }
  return url.toString();
}

async function main(): Promise<void> {
  const cubeUrl = (process.env.CUBE_API_URL ?? "https://albert-cube.fly.dev").replace(/\/$/u, "");
  const secret = process.env.CUBEJS_API_SECRET?.trim();
  if (!secret) throw new Error("CUBEJS_API_SECRET is required.");

  const pool = new pg.Pool({ connectionString: leaseDbUrl(), ssl: { rejectUnauthorized: false }, max: 1 });
  const turnId = ulid();
  let conversationId = "";
  const client = await pool.connect();
  try {
    await client.query("set role albert_control_migration_owner");
    await client.query(
      "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)",
      [ACTOR_ID],
    );
    const begun = await client.query<{ conversation_id: string }>(
      "select conversation_id from public.begin_albert_turn(null, $1, $2, $3::jsonb, null, null)",
      [turnId, "Stripe Cube probe", JSON.stringify({ kind: "stripe_cube_probe" })],
    );
    conversationId = String(begun.rows[0]?.conversation_id ?? "");
    if (!conversationId) throw new Error("begin_albert_turn returned no conversation id");
    await client.query(
      "update control_plane.conversation_turns set lease_expires_at = clock_timestamp() + interval '15 minutes' where turn_id = $1",
      [turnId],
    );

    const bearer = signCubeJwt({
      secret,
      expiresInSeconds: 900,
      securityContext: {
        tenant_id: TENANT_ID,
        role: "owner",
        specialist_agent_id: "general",
        specialist_agent_version: 1,
        conversation_id: conversationId,
        turn_id: turnId,
      },
    });
    const queries = [
      {
        name: "payments",
        query: {
          measures: [
            "stripe_payments_analytics.charge_count",
            "stripe_payments_analytics.collected_amount",
          ],
          dimensions: ["stripe_payments_analytics.currency"],
        },
      },
      {
        name: "checkout",
        query: {
          measures: ["stripe_checkout_analytics.session_count"],
          dimensions: ["stripe_checkout_analytics.status"],
        },
      },
      {
        name: "catalogue",
        query: {
          measures: ["stripe_catalogue_analytics.product_count"],
        },
      },
      {
        name: "payouts",
        query: {
          measures: [
            "stripe_payouts_analytics.payout_count",
            "stripe_payouts_analytics.payout_amount",
          ],
        },
      },
      {
        name: "balance",
        query: {
          measures: ["stripe_balance_analytics.transaction_count"],
        },
      },
    ] as const;
    const results = [];
    for (const item of queries) {
      const load = await fetch(`${cubeUrl}/cubejs-api/v1/load`, {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: item.query }),
      });
      const payload = await load.json().catch(() => ({}));
      const data = (payload as { data?: unknown[] }).data ?? [];
      results.push({
        name: item.name,
        http: load.status,
        error: typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error.slice(0, 240)
          : null,
        rows: Array.isArray(data) ? data.slice(0, 8) : [],
      });
    }
    console.log(JSON.stringify({ results }));

    await client.query("select public.fail_albert_turn($1, $2, $3)", [
      conversationId, turnId, "albert_codex_answered",
    ]).catch(() => undefined);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
