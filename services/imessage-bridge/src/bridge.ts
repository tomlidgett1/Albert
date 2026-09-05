import { createHash, timingSafeEqual } from "node:crypto";
import { ALBERT_OMNI_MESSAGE_MAX_CHARS } from "../../../packages/albert-omni/src/contracts.js";
import { runOwnerAnalysis } from "./analysis.js";
import type { ImessageBridgeConfig } from "./config.js";
import { mentionsAlbert } from "./contracts.js";
import { decodeInboundMessage, LinqClient, verifyLinqWebhook, type InboundLinqMessage } from "./linq.js";
import { formatAnswerForImessage } from "./format.js";
import { OwnerControlPlane } from "./owner-session.js";
import type { SchedulerStatus } from "./scheduler.js";
import type { AlertsLoopStatus } from "./alerts.js";
import type { DailyBriefStatus } from "./daily-brief.js";

const WEBHOOK_PATH = "/v1/imessage/webhook";
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const DEDUP_TTL_MS = 15 * 60_000;
const SENDER_POLICY_TTL_MS = 30_000;

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

type SenderPolicy = Readonly<{ phones: ReadonlySet<string>; allowGroupChats: boolean }>;

export class ImessageBridgeHandler {
  private readonly linq: LinqClient;
  private readonly store: OwnerControlPlane;
  private readonly seenMessages = new Map<string, number>();
  private readonly activeChats = new Set<string>();
  private senderPolicyCache: Readonly<{ value: SenderPolicy; fetchedAt: number }> | null = null;
  private schedulerStatus: (() => SchedulerStatus | Readonly<{ enabled: false }>) | null = null;
  private alertsStatus: (() => AlertsLoopStatus | Readonly<{ enabled: false }>) | null = null;
  private dailyBriefStatus: (() => DailyBriefStatus | Readonly<{ enabled: false }>) | null = null;

  constructor(private readonly config: ImessageBridgeConfig) {
    this.linq = new LinqClient(config.linqApiBaseUrl, config.linqApiToken);
    this.store = new OwnerControlPlane({
      supabaseUrl: config.supabaseUrl,
      anonKey: config.supabaseAnonKey,
      serviceKey: config.supabaseServiceKey,
      ownerEmail: config.ownerEmail,
    });
  }

  /** The owner session the scheduler shares (one session mint, one cache). */
  get controlPlane(): OwnerControlPlane {
    return this.store;
  }

  /** The Linq client the scheduler sends through. */
  get linqClient(): LinqClient {
    return this.linq;
  }

  /** Lets /readyz report the scheduler loop alongside the webhook state. */
  setSchedulerStatus(status: () => SchedulerStatus | Readonly<{ enabled: false }>): void {
    this.schedulerStatus = status;
  }

  /** Lets /readyz report the alerts evaluator loop too. */
  setAlertsStatus(status: () => AlertsLoopStatus | Readonly<{ enabled: false }>): void {
    this.alertsStatus = status;
  }

  /** Lets /readyz report the daily-look loop as well. */
  setDailyBriefStatus(status: () => DailyBriefStatus | Readonly<{ enabled: false }>): void {
    this.dailyBriefStatus = status;
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
        scheduler: this.schedulerStatus?.() ?? null,
        alerts: this.alertsStatus?.() ?? null,
        dailyBrief: this.dailyBriefStatus?.() ?? null,
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
    const policy = await this.senderPolicy();
    if (!this.config.allowedSenders.includes(message.from) && !policy.phones.has(message.from)) {
      // The enrolment boundary: only enrolled handles reach Albert. The env
      // allowlist stays a backstop so the owner can never be locked out.
      log("imessage_sender_rejected", { from: message.from, chatId: message.chatId });
      return acknowledged();
    }
    if (message.isGroupChat) {
      if (!policy.allowGroupChats) {
        log("imessage_group_rejected", { chatId: message.chatId, reason: "groups_disabled" });
        return acknowledged();
      }
      // In a group Albert speaks only when spoken to.
      if (!mentionsAlbert(message.text)) return acknowledged();
    }
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

  /**
   * The tenant's enrolled numbers and group switch, briefly cached. When the
   * control plane is unreachable the env allowlist still answers (fail
   * closed for everyone else, never for the owner).
   */
  private async senderPolicy(): Promise<SenderPolicy> {
    const cached = this.senderPolicyCache;
    if (cached && Date.now() - cached.fetchedAt < SENDER_POLICY_TTL_MS) return cached.value;
    try {
      const workspace = await this.store.imessageWorkspace();
      const value: SenderPolicy = Object.freeze({
        phones: new Set(
          workspace.enrollments
            .filter((enrollment) => enrollment.enabled)
            .map((enrollment) => enrollment.phone),
        ),
        allowGroupChats: workspace.allowGroupChats,
      });
      this.senderPolicyCache = Object.freeze({ value, fetchedAt: Date.now() });
      return value;
    } catch (error) {
      log("imessage_sender_policy_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return Object.freeze({ phones: new Set<string>(), allowGroupChats: false });
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

  /**
   * One inbound question: continue the chat's standing conversation (found
   * by its stable title), run the analysis as the owner, reply in bubbles.
   * The analysis itself is shared with the scheduler (analysis.ts).
   */
  private async runOwnerTurn(message: InboundLinqMessage): Promise<void> {
    const question = message.text.slice(0, ALBERT_OMNI_MESSAGE_MAX_CHARS);
    const title = imessageConversationTitle(message.chatId);
    const existingConversationId = await this.store.findConversationByTitle(title) ?? undefined;
    const result = await runOwnerAnalysis({ store: this.store, config: this.config, log }, {
      question,
      ...(existingConversationId ? { conversationId: existingConversationId } : { newConversationTitle: title }),
    });
    const reply = result.clarification || result.answerText || "The analysis finished without an answer. Try asking again.";
    await Promise.allSettled([this.linq.stopTyping(message.chatId)]);
    const bubbles = await this.sendBubbles(message.chatId, reply);
    log("imessage_reply_sent", {
      chatId: message.chatId,
      conversationId: result.conversationId,
      turnId: result.turnId,
      answerState: result.answerState,
      bubbles,
    });
  }
}
