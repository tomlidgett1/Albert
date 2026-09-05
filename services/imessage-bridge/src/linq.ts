import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal Linq Blue v3 partner API client and webhook decoding for the
 * iMessage bridge. Mirrors the payload shapes the production Nest agent has
 * exercised against this API since mid-2026; https://docs.linqapp.com is the
 * contract of record.
 */

const WEBHOOK_MAX_AGE_MS = 5 * 60_000;

export type LinqTextDecoration = Readonly<{
  range: readonly [number, number];
  style: "bold" | "italic" | "strikethrough" | "underline";
}>;

export class LinqApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LinqApiError";
  }
}

export class LinqClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {}

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.includes("<!DOCTYPE") || text.includes("<html")
        ? "[html error page]"
        : text.slice(0, 200);
      throw new LinqApiError(`Linq API ${response.status}: ${detail}`, response.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Sends one text bubble into an existing chat. */
  async sendMessage(
    chatId: string,
    text: string,
    decorations: readonly LinqTextDecoration[] = [],
  ): Promise<void> {
    const part: Record<string, unknown> = { type: "text", value: text };
    if (decorations.length > 0) {
      part.text_decorations = decorations.map((decoration) => ({
        range: [...decoration.range],
        style: decoration.style,
      }));
    }
    await this.request(`/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: { parts: [part] } }),
    });
  }

  /** Opens (or reuses) a direct chat by sending an initial message. */
  async createChat(
    from: string,
    to: string,
    text: string,
    decorations: readonly LinqTextDecoration[] = [],
  ): Promise<string | null> {
    const part: Record<string, unknown> = { type: "text", value: text };
    if (decorations.length > 0) {
      part.text_decorations = decorations.map((decoration) => ({
        range: [...decoration.range],
        style: decoration.style,
      }));
    }
    const created = await this.request<{ chat?: { id?: string } }>("/chats", {
      method: "POST",
      body: JSON.stringify({ from, to: [to], message: { parts: [part] } }),
    });
    return created.chat?.id ?? null;
  }

  async markAsRead(chatId: string): Promise<void> {
    await this.request(`/chats/${encodeURIComponent(chatId)}/read`, { method: "POST" });
  }

  async startTyping(chatId: string): Promise<void> {
    await this.request(`/chats/${encodeURIComponent(chatId)}/typing`, { method: "POST" });
  }

  async stopTyping(chatId: string): Promise<void> {
    await this.request(`/chats/${encodeURIComponent(chatId)}/typing`, { method: "DELETE" });
  }
}

/**
 * Standard Webhooks verification (webhook-id / webhook-timestamp /
 * webhook-signature headers, HMAC-SHA256 over "{id}.{timestamp}.{body}" with
 * the base64-decoded whsec_ secret, 5-minute replay window).
 */
export function verifyLinqWebhook(input: Readonly<{
  secret: string;
  body: string;
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookSignature: string | null;
  nowMs?: number;
}>): boolean {
  if (!input.webhookId || !input.webhookTimestamp || !input.webhookSignature) return false;
  const timestampSeconds = Number(input.webhookTimestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageMs = (input.nowMs ?? Date.now()) - timestampSeconds * 1000;
  if (ageMs > WEBHOOK_MAX_AGE_MS || ageMs < -WEBHOOK_MAX_AGE_MS) return false;
  let key: Buffer;
  try {
    key = Buffer.from(input.secret.replace(/^whsec_/u, ""), "base64");
  } catch {
    return false;
  }
  if (key.byteLength < 16) return false;
  const expected = createHmac("sha256", key)
    .update(`${input.webhookId}.${input.webhookTimestamp}.${input.body}`)
    .digest();
  // The header carries space-separated "v1,{base64}" entries (key rotation).
  for (const candidate of input.webhookSignature.split(/\s+/u)) {
    const value = candidate.startsWith("v1,") ? candidate.slice(3) : null;
    if (!value) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return false;
}

export type InboundLinqMessage = Readonly<{
  eventId: string;
  messageId: string;
  chatId: string;
  from: string;
  botNumber: string;
  text: string;
  isGroupChat: boolean;
  hasMedia: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes a webhook body into the one shape the bridge answers: an inbound
 * message.received event. Anything else (receipts, reactions, our own
 * outbound messages, malformed payloads) returns null and is acknowledged
 * without processing.
 */
export function decodeInboundMessage(payload: unknown): InboundLinqMessage | null {
  if (!isRecord(payload) || payload.event_type !== "message.received") return null;
  const data = payload.data;
  if (!isRecord(data)) return null;
  const sender = isRecord(data.sender_handle) ? data.sender_handle : null;
  if (!sender || sender.is_me === true || data.direction === "outbound") return null;
  const chat = isRecord(data.chat) ? data.chat : null;
  const owner = chat && isRecord(chat.owner_handle) ? chat.owner_handle : null;
  const from = typeof sender.handle === "string" ? sender.handle.trim() : "";
  const botNumber = owner && typeof owner.handle === "string" ? owner.handle.trim() : "";
  const chatId = chat && typeof chat.id === "string" ? chat.id : "";
  const messageId = typeof data.id === "string" ? data.id : "";
  if (!from || !botNumber || !chatId || !messageId) return null;
  const parts = Array.isArray(data.parts) ? data.parts : [];
  const text = parts
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
    .map((part) => (typeof part.value === "string" ? part.value : ""))
    .join("\n")
    .trim();
  const hasMedia = parts.some((part) => isRecord(part) && part.type === "media");
  return Object.freeze({
    eventId: typeof payload.event_id === "string" ? payload.event_id : messageId,
    messageId,
    chatId,
    from,
    botNumber,
    text,
    isGroupChat: chat?.is_group === true,
    hasMedia,
  });
}
