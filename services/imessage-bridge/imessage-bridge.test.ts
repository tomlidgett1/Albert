import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ulid } from "ulid";
import { omniServiceTurnSchema } from "../../packages/albert-omni/src/contracts.js";
import { OMNI_IMESSAGE_DELIVERY_INSTRUCTIONS } from "../../packages/albert-omni/src/runtime.js";
import { loadImessageBridgeConfig } from "./src/config.js";
import { decodeInboundMessage, verifyLinqWebhook } from "./src/linq.js";
import { extractTextDecorations, formatAnswerForImessage } from "./src/format.js";
import { ImessageBridgeHandler, imessageConversationTitle } from "./src/bridge.js";

const WEBHOOK_SECRET = `whsec_${Buffer.from("t".repeat(32)).toString("base64")}`;

function baseTurn(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: ulid(),
    tenantId: "01KZN20VTX2EWW1TQ2AA3MCPW6",
    actorId: "e6a1b354-ffbc-41c0-8131-d2f018dba818",
    role: "owner",
    conversationId: ulid(),
    turnId: ulid(),
    message: "How were sales last week?",
    priorConversation: [],
    activeConnectors: ["lightspeed-r"],
    connectorFreshness: [],
    timezone: "Australia/Melbourne",
    organisationName: "Ashburton Cycles",
    cubeBearer: "a.b.c",
    model: "claude-haiku-4-5-20251001",
    effort: "max",
    fastMode: false,
  };
}

test("omni turn schema accepts the imessage channel and stays strict", () => {
  assert.equal(omniServiceTurnSchema.safeParse(baseTurn()).success, true);
  const imessage = omniServiceTurnSchema.safeParse({ ...baseTurn(), channel: "imessage" });
  assert.equal(imessage.success, true);
  assert.equal(imessage.success && imessage.data.channel, "imessage");
  assert.equal(omniServiceTurnSchema.safeParse({ ...baseTurn(), channel: "sms" }).success, false);
  assert.equal(omniServiceTurnSchema.safeParse({ ...baseTurn(), unknownField: true }).success, false);
});

test("imessage delivery instructions override rendering, not rigour", () => {
  assert.match(OMNI_IMESSAGE_DELIVERY_INSTRUCTIONS, /NO markdown tables/u);
  assert.match(OMNI_IMESSAGE_DELIVERY_INSTRUCTIONS, /\*\*bold\*\*/u);
  assert.match(OMNI_IMESSAGE_DELIVERY_INSTRUCTIONS, /arithmetic discipline[\s\S]*unchanged/iu);
});

function signedHeaders(body: string, secret = WEBHOOK_SECRET, atMs = Date.now()): Record<string, string> {
  const webhookId = `msg_${ulid()}`;
  const timestamp = String(Math.floor(atMs / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/u, ""), "base64");
  const signature = createHmac("sha256", key).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
  return {
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
}

test("standard webhooks verification accepts valid and rejects tampered deliveries", () => {
  const body = JSON.stringify({ event_type: "message.received" });
  const headers = signedHeaders(body);
  const verify = (overrides: Partial<Record<"body" | "secret" | "signature" | "timestamp", string>>) =>
    verifyLinqWebhook({
      secret: overrides.secret ?? WEBHOOK_SECRET,
      body: overrides.body ?? body,
      webhookId: headers["webhook-id"]!,
      webhookTimestamp: overrides.timestamp ?? headers["webhook-timestamp"]!,
      webhookSignature: overrides.signature ?? headers["webhook-signature"]!,
    });
  assert.equal(verify({}), true);
  assert.equal(verify({ body: `${body} ` }), false);
  assert.equal(verify({ secret: `whsec_${Buffer.from("x".repeat(32)).toString("base64")}` }), false);
  assert.equal(verify({ signature: "v1,AAAA" }), false);
  // Multiple space-separated signatures: any valid entry passes.
  assert.equal(verify({ signature: `v1,AAAA ${headers["webhook-signature"]}` }), true);
  // Replay protection: a six-minute-old timestamp is rejected.
  const stale = signedHeaders(body, WEBHOOK_SECRET, Date.now() - 6 * 60_000);
  assert.equal(verifyLinqWebhook({
    secret: WEBHOOK_SECRET,
    body,
    webhookId: stale["webhook-id"]!,
    webhookTimestamp: stale["webhook-timestamp"]!,
    webhookSignature: stale["webhook-signature"]!,
  }), false);
});

function inboundEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_version: "v3",
    event_id: `evt_${ulid()}`,
    event_type: "message.received",
    data: {
      id: `msg_${ulid()}`,
      direction: "inbound",
      chat: {
        id: "0d7e6f5a-1111-2222-3333-444455556666",
        is_group: false,
        owner_handle: { handle: "+16502831814", is_me: true },
      },
      sender_handle: { handle: "+61414187820", is_me: false },
      parts: [{ type: "text", value: "How were sales last week?" }],
      ...overrides,
    },
  };
}

test("inbound decoding accepts the owner's message and skips everything else", () => {
  const decoded = decodeInboundMessage(inboundEvent());
  assert.ok(decoded);
  assert.equal(decoded.from, "+61414187820");
  assert.equal(decoded.botNumber, "+16502831814");
  assert.equal(decoded.text, "How were sales last week?");
  assert.equal(decoded.isGroupChat, false);
  assert.equal(decodeInboundMessage({ event_type: "message.delivered" }), null);
  assert.equal(decodeInboundMessage(inboundEvent({ direction: "outbound" })), null);
  assert.equal(decodeInboundMessage(inboundEvent({ sender_handle: { handle: "+16502831814", is_me: true } })), null);
});

test("answer formatting converts markdown structure to text-message form", () => {
  const answer = [
    "Sales hit **$12,400** last week, up 8% on the week before.",
    "",
    "### Top categories",
    "",
    "| Category | Sales | Share |",
    "| --- | ---: | ---: |",
    "| Bikes | $8,200 | 66% |",
    "| Accessories | $2,900 | 23% |",
    "",
    "---",
    "",
    "Margin held at *58%* — worth keeping the [discount policy](?ai-query=discounts) as is.",
    "",
    "[How does this compare to last year?](?ai-query=How%20does%20this%20compare)",
  ].join("\n");
  const bubbles = formatAnswerForImessage(answer);
  assert.equal(bubbles.length, 2);
  const first = bubbles[0]!;
  assert.match(first.text, /Sales hit \$12,400 last week/u);
  assert.match(first.text, /Top categories/u);
  assert.match(first.text, /Bikes: \$8,200 · 66%/u);
  assert.doesNotMatch(first.text, /[|#]/u);
  const bold = first.decorations.find((decoration) => decoration.style === "bold");
  assert.ok(bold);
  assert.equal(first.text.slice(bold.range[0], bold.range[1]), "$12,400");
  const second = bubbles[1]!;
  assert.doesNotMatch(second.text, /ai-query|\[|\]/u);
  assert.doesNotMatch(second.text, /—/u);
  const italic = second.decorations.find((decoration) => decoration.style === "italic");
  assert.ok(italic);
  assert.equal(second.text.slice(italic.range[0], italic.range[1]), "58%");
});

test("bubble splitting caps at three and merges the tail", () => {
  const answer = ["one", "---", "two", "---", "three", "---", "four"].join("\n");
  const bubbles = formatAnswerForImessage(answer);
  assert.equal(bubbles.length, 3);
  assert.match(bubbles[2]!.text, /three[\s\S]*four/u);
});

test("decoration extraction leaves arithmetic and unmatched markers alone", () => {
  const { value, decorations } = extractTextDecorations("5 * 3 = 15 and **bold** stays");
  assert.equal(value, "5 * 3 = 15 and bold stays");
  assert.equal(decorations.length, 1);
  assert.equal(decorations[0]!.style, "bold");
});

function bridgeEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "8797",
    LINQ_API_TOKEN: "linq-token",
    LINQ_WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
    LINQ_WEBHOOK_URL_TOKEN: "u".repeat(32),
    ALBERT_IMESSAGE_BOT_NUMBER: "+16502831814",
    ALBERT_IMESSAGE_ALLOWED_SENDERS: "+61414187820",
    ALBERT_IMESSAGE_OWNER_EMAIL: "tom@lidgett.net",
    ALBERT_IMESSAGE_SUPABASE_URL: "https://jjiugnriaypjoxsupjft.supabase.co",
    ALBERT_IMESSAGE_SUPABASE_ANON_KEY: "anon",
    ALBERT_IMESSAGE_SUPABASE_SERVICE_KEY: "service",
    CUBEJS_API_SECRET: "cube-secret",
    CODEX_RUNTIME_SERVICE_URL: "https://albert-codex-runtime.fly.dev",
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: "s".repeat(48),
  };
}

test("bridge config locks haiku at max effort and validates its boundary", () => {
  const config = loadImessageBridgeConfig(bridgeEnv());
  assert.equal(config.model, "claude-haiku-4-5-20251001");
  assert.equal(config.effort, "max");
  assert.deepEqual([...config.allowedSenders], ["+61414187820"]);
  assert.throws(() => loadImessageBridgeConfig({ ...bridgeEnv(), ALBERT_IMESSAGE_ALLOWED_SENDERS: "0414187820" }));
  assert.throws(() => loadImessageBridgeConfig({ ...bridgeEnv(), LINQ_WEBHOOK_SIGNING_SECRET: "plain-secret" }));
  assert.throws(() => loadImessageBridgeConfig({ ...bridgeEnv(), LINQ_WEBHOOK_URL_TOKEN: "short" }));
});

test("webhook endpoint rejects bad tokens and signatures, acknowledges filtered events", async () => {
  const handler = new ImessageBridgeHandler(loadImessageBridgeConfig(bridgeEnv()));
  const url = (token: string) => `http://127.0.0.1:8797/v1/imessage/webhook?token=${token}`;
  const post = (target: string, body: string, headers: Record<string, string> = {}) =>
    handler.handle(new Request(target, { method: "POST", body, headers }));

  const body = JSON.stringify(inboundEvent({ sender_handle: { handle: "+61400000000", is_me: false } }));
  assert.equal((await post(url("wrong-token"), body, signedHeaders(body))).status, 401);
  assert.equal((await post(url("u".repeat(32)), body)).status, 401);
  const badSignature = { ...signedHeaders(body), "webhook-signature": "v1,AAAA" };
  assert.equal((await post(url("u".repeat(32)), body, badSignature)).status, 401);
  // A disallowed sender is acknowledged silently — Linq must not retry it.
  const rejected = await post(url("u".repeat(32)), body, signedHeaders(body));
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { received: true });
  // Group chats and receipt events are acknowledged without processing.
  const groupBody = JSON.stringify(inboundEvent({ chat: {
    id: "9d7e6f5a-1111-2222-3333-444455556666",
    is_group: true,
    owner_handle: { handle: "+16502831814", is_me: true },
  } }));
  assert.equal((await post(url("u".repeat(32)), groupBody, signedHeaders(groupBody))).status, 200);
  const receiptBody = JSON.stringify({ event_type: "message.delivered", data: {} });
  assert.equal((await post(url("u".repeat(32)), receiptBody, signedHeaders(receiptBody))).status, 200);
  // Health endpoints answer without auth.
  assert.equal((await handler.handle(new Request("http://127.0.0.1:8797/livez"))).status, 200);
  assert.equal((await handler.handle(new Request("http://127.0.0.1:8797/readyz"))).status, 200);
});

test("conversation titles are stable per chat and opaque", () => {
  const title = imessageConversationTitle("0d7e6f5a-1111-2222-3333-444455556666");
  assert.equal(title, imessageConversationTitle("0d7e6f5a-1111-2222-3333-444455556666"));
  assert.notEqual(title, imessageConversationTitle("another-chat"));
  assert.match(title, /^iMessage · [0-9a-f]{8}$/u);
});
