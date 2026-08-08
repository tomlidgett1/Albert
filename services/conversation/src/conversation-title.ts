import OpenAI from "openai";

/** Cheapest, lowest-latency OpenAI model suitable for short titles. */
export const CONVERSATION_TITLE_MODEL = "gpt-5-nano";

const TITLE_INSTRUCTIONS =
  "You title analytics chat threads. Reply with only a short title based on the user question. "
  + "Maximum 6 words. No quotation marks. No trailing punctuation. Australian English.";

export function sanitizeConversationTitle(value: string, maxLength = 60): string | null {
  let cleaned = value.replace(/\s+/gu, " ").trim();
  cleaned = cleaned.replace(/^["'`]+/u, "").replace(/["'`]+$/u, "");
  cleaned = cleaned.replace(/[.!?]+$/u, "").trim();
  // Model sometimes keeps a closing quote before the final stop.
  cleaned = cleaned.replace(/^["'`]+/u, "").replace(/["'`]+$/u, "").trim();
  if (!cleaned) return null;
  if (/^(title|untitled|new analysis|conversation)\b/iu.test(cleaned)) return null;
  return cleaned.slice(0, maxLength).trim() || null;
}

export async function generateConversationTitle(options: Readonly<{
  question: string;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  client?: OpenAI;
}>): Promise<string | null> {
  const question = options.question.trim().slice(0, 500);
  if (!question) return null;

  const client = options.client ?? new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: 8_000,
    maxRetries: 0,
  });

  const response = await client.responses.create({
    model: CONVERSATION_TITLE_MODEL,
    store: false,
    max_output_tokens: 32,
    reasoning: { effort: "minimal" },
    input: [
      { role: "developer", content: TITLE_INSTRUCTIONS },
      { role: "user", content: question },
    ],
  }, { signal: options.signal });

  const raw = typeof response.output_text === "string" ? response.output_text : "";
  return sanitizeConversationTitle(raw);
}
