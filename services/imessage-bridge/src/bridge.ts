import { createHash, timingSafeEqual } from "node:crypto";
import { ulid } from "ulid";
import { signCubeJwt } from "../../../packages/albert-v3/src/cube/jwt.js";
import {
  ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
  ALBERT_OMNI_ANALYTICAL_RUNTIME,
  ALBERT_OMNI_MESSAGE_MAX_CHARS,
  ALBERT_OMNI_PROTOCOL_VERSION,
  ALBERT_OMNI_RUNTIME,
  type OmniServiceTurn,
} from "../../../packages/albert-omni/src/contracts.js";
import { OmniRuntimeServiceClient } from "../../../packages/albert-omni/src/service-client.js";
import type { OmniTraceEventInput } from "../../../packages/albert-omni/src/runtime.js";
import {
  codexSocialProvenance,
  codexSocialReply,
  detectCodexSocialMessage,
} from "../../../packages/albert-codex/src/social.js";
import { isAlbertModelId, providerForModel } from "../../../packages/shared/src/agent-runtime.js";
import type { ImessageBridgeConfig } from "./config.js";
import { decodeInboundMessage, LinqClient, verifyLinqWebhook, type InboundLinqMessage } from "./linq.js";
import { formatAnswerForImessage } from "./format.js";
import { createPersistingEmitter, OwnerControlPlane } from "./owner-session.js";

const WEBHOOK_PATH = "/v1/imessage/webhook";
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const DEDUP_TTL_MS = 15 * 60_000;
const LEASE_RENEWAL_INTERVAL_MS = 120_000;
const TURN_TIMEOUT_MS = ALBERT_OMNI_ANALYSIS_TIMEOUT_MS + 60_000;

const BUSY_REPLY = "Still working on your last question — give me a moment and ask again.";
const MEDIA_ONLY_REPLY = "I can only read text here for now. Type the question and I'll dig into the numbers.";
const FAILURE_REPLY = "Sorry, I hit a problem analysing that one. Give it another go in a minute.";

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields, at: new Date().toISOString() })}\n`);
}

function tokensMatch(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(provided).digest();
  return timingSafeEqual(left, right);
}

function acknowledged(): Response {
  return Response.json({ received: true }, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/** The standing conversation title for one Linq chat, stable across turns. */
export function imessageConversationTitle(chatId: string): string {
  const digest = createHash("sha256").update(chatId).digest("hex").slice(0, 8);
  return `iMessage · ${digest}`;
}

export class ImessageBridgeHandler {
  private readonly linq: LinqClient;
  private readonly store: OwnerControlPlane;
  private readonly seenMessages = new Map<string, number>();
  private readonly activeChats = new Set<string>();

  constructor(private readonly config: ImessageBridgeConfig) {
    this.linq = new LinqClient(config.linqApiBaseUrl, config.linqApiToken);
    this.store = new OwnerControlPlane({
      supabaseUrl: config.supabaseUrl,
      anonKey: config.supabaseAnonKey,
      serviceKey: config.supabaseServiceKey,
      ownerEmail: config.ownerEmail,
    });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/livez") {
      return Response.json({ ok: true, service: "albert-imessage-bridge" }, {
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      return Response.json({
        ready: true,
        releaseSha: this.config.releaseSha,
        deploymentId: this.config.deploymentId,
        botNumber: this.config.botNumber,
        activeChats: this.activeChats.size,
      }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method !== "POST" || url.pathname !== WEBHOOK_PATH) {
      return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    }
    if (!tokensMatch(this.config.linqWebhookUrlToken, url.searchParams.get("token"))) {
      return Response.json({ error: { code: "unauthorised", message: "Rejected." } }, { status: 401 });
    }
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
      return Response.json({ error: { code: "request_too_large", message: "Too large." } }, { status: 413 });
    }
    const verified = verifyLinqWebhook({
      secret: this.config.linqWebhookSigningSecret,
      body,
      webhookId: request.headers.get("webhook-id"),
      webhookTimestamp: request.headers.get("webhook-timestamp"),
      webhookSignature: request.headers.get("webhook-signature"),
    });
    if (!verified) {
      return Response.json({ error: { code: "unauthorised", message: "Rejected." } }, { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return acknowledged();
    }
    const message = decodeInboundMessage(payload);
    if (!message) return acknowledged();
    if (message.botNumber !== this.config.botNumber) return acknowledged();
    if (!this.config.allowedSenders.includes(message.from)) {
      // The enrolment boundary: only the owner's handle reaches Albert.
      log("imessage_sender_rejected", { from: message.from, chatId: message.chatId });
      return acknowledged();
    }
    if (message.isGroupChat) return acknowledged();
    this.pruneSeenMessages();
    if (this.seenMessages.has(message.messageId)) return acknowledged();
    this.seenMessages.set(message.messageId, Date.now());
    // Linq expects the delivery acknowledged within ten seconds; the turn
    // continues in this long-lived process after the response goes out.
    void this.processMessage(message).catch((error) => {
      log("imessage_processing_failed", {
        chatId: message.chatId,
        messageId: message.messageId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    });
    return acknowledged();
  }

  private pruneSeenMessages(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [id, seenAt] of this.seenMessages) {
      if (seenAt < cutoff) this.seenMessages.delete(id);
    }
  }

  private async sendBubbles(chatId: string, markdown: string): Promise<number> {
    const bubbles = formatAnswerForImessage(markdown);
    for (const bubble of bubbles) {
      await this.linq.sendMessage(chatId, bubble.text, bubble.decorations);
    }
    return bubbles.length;
  }

  private async processMessage(message: InboundLinqMessage): Promise<void> {
    if (!message.text) {
      if (message.hasMedia) await this.sendBubbles(message.chatId, MEDIA_ONLY_REPLY);
      return;
    }
    if (this.activeChats.has(message.chatId)) {
      await this.sendBubbles(message.chatId, BUSY_REPLY);
      return;
    }
    this.activeChats.add(message.chatId);
    const startedAt = Date.now();
    try {
      await Promise.allSettled([
        this.linq.markAsRead(message.chatId),
        this.linq.startTyping(message.chatId),
      ]);
      await this.runOwnerTurn(message);
      log("imessage_turn_finished", {
        chatId: message.chatId,
        messageId: message.messageId,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      log("imessage_turn_failed", {
        chatId: message.chatId,
        messageId: message.messageId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      await Promise.allSettled([
        this.linq.stopTyping(message.chatId),
        this.sendBubbles(message.chatId, FAILURE_REPLY),
      ]);
    } finally {
      this.activeChats.delete(message.chatId);
    }
  }

  private async runOwnerTurn(message: InboundLinqMessage): Promise<void> {
    const question = message.text.slice(0, ALBERT_OMNI_MESSAGE_MAX_CHARS);
    const tenant = await this.store.tenantContext();
    const title = imessageConversationTitle(message.chatId);
    const existingConversationId = await this.store.findConversationByTitle(title) ?? undefined;
    const turnId = ulid();
    const runtimeProfile = {
      provider: isAlbertModelId(this.config.model) ? providerForModel(this.config.model) : "anthropic",
      runtime: ALBERT_OMNI_RUNTIME,
      analyticalRuntime: ALBERT_OMNI_ANALYTICAL_RUNTIME,
      model: this.config.model,
      reasoningEffort: this.config.effort,
      fastMode: false,
      channel: "imessage",
      analysisTimeoutMs: ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
    } as const;
    let conversationId: string;
    try {
      conversationId = await this.store.beginTurn({
        ...(existingConversationId ? { conversationId: existingConversationId } : {}),
        turnId,
        message: question,
        runtimeProfile,
      });
    } catch (error) {
      // A running turn from a crashed process holds the conversation; this
      // process is not running one (activeChats gates that), so release and
      // retry once before giving up.
      if (existingConversationId && /running|55000/iu.test(error instanceof Error ? error.message : "")) {
        await this.store.releaseRunningTurns(existingConversationId);
        conversationId = await this.store.beginTurn({
          conversationId: existingConversationId,
          turnId,
          message: question,
          runtimeProfile,
        });
      } else {
        throw error;
      }
    }
    if (!existingConversationId) {
      await this.store.assignConversationTitle(conversationId, title).catch(() => undefined);
    }

    const emitter = createPersistingEmitter({
      store: this.store,
      conversationId,
      turnId,
      onPersistError: (error, event) => log("imessage_trace_persist_failed", {
        conversationId,
        turnId,
        eventType: (event as { type?: string }).type,
        error: error instanceof Error ? error.message : String(error),
      }),
    });

    const social = detectCodexSocialMessage(question);
    if (social) {
      const reply = codexSocialReply(social, question);
      await emitter.emit({
        type: "answer",
        status: "complete",
        state: "Verified",
        text: reply.text,
        provenance: codexSocialProvenance(),
        followUps: [],
        presentedResultIds: [],
        claims: [],
      });
      await emitter.drain();
      await this.store.failTurn(conversationId, turnId, "albert_omni_social_answered");
      await Promise.allSettled([this.linq.stopTyping(message.chatId)]);
      await this.sendBubbles(message.chatId, reply.text);
      return;
    }

    const [priorConversation, routing, businessContext] = await Promise.all([
      existingConversationId
        ? this.store.priorConversation(conversationId).catch(() => [] as const)
        : Promise.resolve([] as const),
      this.store.connectorRouting(),
      this.store.businessContext(),
    ]);
    // The current turn's user message is already stored; the model context
    // RPC returns finished turns only, so no self-echo trim is needed.
    const cubeBearer = signCubeJwt({
      secret: this.config.cubeApiSecret,
      expiresInSeconds: 2_700,
      securityContext: {
        tenant_id: tenant.tenant_id,
        role: tenant.role,
        specialist_agent_id: "general",
        specialist_agent_version: 1,
        conversation_id: conversationId,
        turn_id: turnId,
      },
    });
    const turn: OmniServiceTurn = {
      protocolVersion: ALBERT_OMNI_PROTOCOL_VERSION,
      requestId: ulid(),
      tenantId: tenant.tenant_id,
      actorId: await this.store.ownerUserId(),
      role: tenant.role,
      conversationId,
      turnId,
      message: question,
      priorConversation: [...priorConversation],
      activeConnectors: [...routing.activeConnectors],
      connectorFreshness: routing.freshness.map((entry) => ({
        connector: entry.connector,
        domain: entry.domain,
        dataThrough: entry.dataThrough,
      })),
      ...(businessContext ? { businessContext } : {}),
      timezone: tenant.timezone,
      ownerName: "Tom",
      organisationName: tenant.tenant_name.slice(0, 160),
      cubeBearer,
      model: this.config.model,
      effort: this.config.effort,
      fastMode: false,
      channel: "imessage",
    };

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("The analysis timed out.")), TURN_TIMEOUT_MS);
    const leaseRenewal = setInterval(() => {
      void this.store.renewTurnLease(turnId).catch(() => undefined);
    }, LEASE_RENEWAL_INTERVAL_MS);
    let answerText = "";
    let answerState = "";
    let clarification = "";
    // Replayable tables arrive with an empty dashboardReplay.queryEventId and
    // a resultId pairing them to their query event; the caller stamps event
    // ids, so the pairing happens here exactly as in the web route — an
    // unpairable reference is stripped so a broken replay ref never persists.
    const queryEventIdByResultId = new Map<string, string>();
    try {
      const client = new OmniRuntimeServiceClient(this.config.runtimeServiceUrl, this.config.runtimeSigningSecret);
      const result = await client.runTurn(
        turn,
        async (event: OmniTraceEventInput) => {
          if (event.type === "answer") {
            answerText = event.text;
            answerState = event.state;
          } else if (event.type === "clarification") {
            clarification = [
              event.question,
              ...event.options.map((option, index) => `${index + 1}. ${option.label}`),
            ].join("\n");
            answerState = "Clarification";
          }
          let outbound = event as unknown as Record<string, unknown>;
          const replay = (outbound as {
            type?: string;
            resultId?: string;
            dashboardReplay?: { kind?: string; queryEventId?: string };
          });
          if (replay.type === "table" && replay.dashboardReplay?.kind === "cube_v3" && !replay.dashboardReplay.queryEventId) {
            const queryEventId = replay.resultId ? queryEventIdByResultId.get(replay.resultId) : undefined;
            if (queryEventId) {
              outbound = { ...outbound, dashboardReplay: { ...replay.dashboardReplay, queryEventId } };
            } else {
              outbound = { ...outbound };
              delete outbound.dashboardReplay;
            }
          }
          const stamped = await emitter.emit(outbound) as unknown as { type?: string; resultId?: string; id?: string };
          if (stamped.type === "query" && stamped.resultId && stamped.id) {
            queryEventIdByResultId.set(stamped.resultId, stamped.id);
          }
        },
        abort.signal,
        async () => undefined,
      );
      if (!answerState) answerState = result.answerState;
      await emitter.drain();
      await this.store.failTurn(
        conversationId,
        turnId,
        answerState === "Unavailable" ? "albert_omni_unavailable" : "albert_omni_answered",
      );
    } catch (error) {
      await emitter.emit({
        type: "error",
        status: "error",
        message: "The analysis could not be completed.",
        recoverable: true,
      }).catch(() => undefined);
      await emitter.drain().catch(() => undefined);
      await this.store.failTurn(conversationId, turnId, "omni_runtime_failure").catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(leaseRenewal);
    }

    const reply = clarification || answerText || "The analysis finished without an answer. Try asking again.";
    await Promise.allSettled([this.linq.stopTyping(message.chatId)]);
    const bubbles = await this.sendBubbles(message.chatId, reply);
    log("imessage_reply_sent", { chatId: message.chatId, conversationId, turnId, answerState, bubbles });
  }
}
