/**
 * The iMessage bridge is a conversation caller in the same trust position as
 * the Vercel web app: it holds the Cube signing secret and Supabase
 * credentials so it can mint turn leases and bearers, and it drives the
 * agent-runtime service over its signed job API. It never executes model
 * turns itself, and it deploys as its own Fly app so none of these
 * credentials enter the codex-runtime boundary.
 */
import { DAILY_BRIEF_REFRESH_MS, DAILY_BRIEF_MODEL } from "../../recommended-analysis/src/daily-brief.js";

export type ImessageBridgeConfig = Readonly<{
  port: number;
  releaseSha: string;
  deploymentId: string;
  /** Linq partner API bearer token (api.linqapp.com). */
  linqApiToken: string;
  linqApiBaseUrl: string;
  /** Standard Webhooks signing secret from the Linq subscription (whsec_...). */
  linqWebhookSigningSecret: string;
  /** Random path token carried in the subscribed target_url query string. */
  linqWebhookUrlToken: string;
  /** The Linq line the bridge answers on (E.164). */
  botNumber: string;
  /** The only sender handles allowed to reach Albert (E.164). */
  allowedSenders: readonly string[];
  /** Auth email of the Albert owner the bridge acts as. */
  ownerEmail: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  cubeApiSecret: string;
  runtimeServiceUrl: string;
  runtimeSigningSecret: string;
  /** Locked model/effort: Claude Haiku 4.5 at max effort, per the owner. */
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Scheduled reports (ADR 0131): the poll loop's switch and cadence. */
  schedulerEnabled: boolean;
  schedulerPollMs: number;
  /** Heads-up alerts (ADR 0132): the evaluator's switch, cadence, quiet hours and the Cube API it queries. */
  alertsEnabled: boolean;
  alertsPollMs: number;
  alertsQuietHours: Readonly<{ from: number; to: number }>;
  cubeApiUrl: string;
  /** The daily look (ADR 0138): switch, polling and 24-hour refresh cadence. */
  dailyBriefEnabled: boolean;
  dailyBriefPollMs: number;
  dailyBriefModel: string;
  dailyBriefRefreshMs: number;
}>;

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function phoneNumber(value: string, name: string): string {
  const trimmed = value.trim();
  if (!/^\+[1-9]\d{5,14}$/u.test(trimmed)) {
    throw new Error(`${name} must be an E.164 phone number.`);
  }
  return trimmed;
}

function httpsUrl(value: string, name: string): string {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error(`${name} must use HTTPS.`);
  return url.toString().replace(/\/+$/u, "");
}

export function loadImessageBridgeConfig(source: NodeJS.ProcessEnv = process.env): ImessageBridgeConfig {
  const port = Number(source.PORT ?? "8797");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid.");
  const releaseSha = source.ALBERT_SERVICE_VERSION?.trim() || "development";
  if (source.NODE_ENV === "production" && !/^[a-f0-9]{40}$/u.test(releaseSha)) {
    throw new Error("ALBERT_SERVICE_VERSION must be the deployed Git SHA.");
  }
  const deploymentId = source.ALBERT_DEPLOYMENT_ID?.trim() || "localhost";
  const signingSecret = required(source, "ALBERT_CODEX_RUNTIME_SIGNING_SECRET");
  if (Buffer.byteLength(signingSecret, "utf8") < 32) {
    throw new Error("ALBERT_CODEX_RUNTIME_SIGNING_SECRET must contain at least 32 UTF-8 bytes.");
  }
  const webhookSecret = required(source, "LINQ_WEBHOOK_SIGNING_SECRET");
  if (!webhookSecret.startsWith("whsec_")) {
    throw new Error("LINQ_WEBHOOK_SIGNING_SECRET must be the whsec_-prefixed Standard Webhooks secret.");
  }
  const urlToken = required(source, "LINQ_WEBHOOK_URL_TOKEN");
  if (urlToken.length < 24) {
    throw new Error("LINQ_WEBHOOK_URL_TOKEN must contain at least 24 characters.");
  }
  const allowedSenders = required(source, "ALBERT_IMESSAGE_ALLOWED_SENDERS")
    .split(",")
    .map((entry) => phoneNumber(entry, "ALBERT_IMESSAGE_ALLOWED_SENDERS"));
  if (allowedSenders.length === 0) throw new Error("ALBERT_IMESSAGE_ALLOWED_SENDERS is required.");
  const schedulerEnabled = !/^(?:false|0|off|no)$/iu.test(source.ALBERT_SCHEDULED_ENABLED?.trim() ?? "");
  const pollSeconds = Number(source.ALBERT_SCHEDULED_POLL_SECONDS?.trim() || "20");
  if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 300) {
    throw new Error("ALBERT_SCHEDULED_POLL_SECONDS must be a whole number of seconds between 5 and 300.");
  }
  const alertsEnabled = !/^(?:false|0|off|no)$/iu.test(source.ALBERT_ALERTS_ENABLED?.trim() ?? "");
  const alertsPollSeconds = Number(source.ALBERT_ALERTS_POLL_SECONDS?.trim() || "60");
  if (!Number.isInteger(alertsPollSeconds) || alertsPollSeconds < 15 || alertsPollSeconds > 900) {
    throw new Error("ALBERT_ALERTS_POLL_SECONDS must be a whole number of seconds between 15 and 900.");
  }
  const quiet = /^(\d{1,2})-(\d{1,2})$/u.exec(source.ALBERT_ALERTS_QUIET_HOURS?.trim() || "21-7");
  if (!quiet || Number(quiet[1]) > 23 || Number(quiet[2]) > 23) {
    throw new Error("ALBERT_ALERTS_QUIET_HOURS must be two local hours like 21-7.");
  }
  const dailyBriefEnabled = !/^(?:false|0|off|no)$/iu.test(source.ALBERT_DAILY_BRIEF_ENABLED?.trim() ?? "");
  const dailyBriefPollSeconds = Number(source.ALBERT_DAILY_BRIEF_POLL_SECONDS?.trim() || "300");
  if (!Number.isInteger(dailyBriefPollSeconds) || dailyBriefPollSeconds < 30 || dailyBriefPollSeconds > 3600) {
    throw new Error("ALBERT_DAILY_BRIEF_POLL_SECONDS must be a whole number of seconds between 30 and 3600.");
  }
  const dailyBriefRefreshSeconds = Number(source.ALBERT_DAILY_BRIEF_REFRESH_SECONDS?.trim() || String(DAILY_BRIEF_REFRESH_MS / 1000));
  if (dailyBriefRefreshSeconds !== DAILY_BRIEF_REFRESH_MS / 1000) {
    throw new Error("ALBERT_DAILY_BRIEF_REFRESH_SECONDS must be 86400 seconds (every 24 hours).");
  }
  const dailyBriefModel = source.ALBERT_DAILY_BRIEF_MODEL?.trim() || DAILY_BRIEF_MODEL;
  if (!/^[a-zA-Z0-9._-]{1,120}$/u.test(dailyBriefModel)) {
    throw new Error("ALBERT_DAILY_BRIEF_MODEL must be a model id.");
  }
  return Object.freeze({
    port,
    releaseSha,
    deploymentId,
    alertsEnabled,
    alertsPollMs: alertsPollSeconds * 1000,
    alertsQuietHours: Object.freeze({ from: Number(quiet[1]), to: Number(quiet[2]) }),
    cubeApiUrl: httpsUrl(source.CUBE_API_URL?.trim() || "https://albert-cube.fly.dev", "CUBE_API_URL"),
    linqApiToken: required(source, "LINQ_API_TOKEN"),
    linqApiBaseUrl: httpsUrl(source.LINQ_API_BASE_URL?.trim() || "https://api.linqapp.com/api/partner/v3", "LINQ_API_BASE_URL"),
    linqWebhookSigningSecret: webhookSecret,
    linqWebhookUrlToken: urlToken,
    botNumber: phoneNumber(required(source, "ALBERT_IMESSAGE_BOT_NUMBER"), "ALBERT_IMESSAGE_BOT_NUMBER"),
    allowedSenders: Object.freeze(allowedSenders),
    ownerEmail: required(source, "ALBERT_IMESSAGE_OWNER_EMAIL"),
    supabaseUrl: httpsUrl(required(source, "ALBERT_IMESSAGE_SUPABASE_URL"), "ALBERT_IMESSAGE_SUPABASE_URL"),
    supabaseAnonKey: required(source, "ALBERT_IMESSAGE_SUPABASE_ANON_KEY"),
    supabaseServiceKey: required(source, "ALBERT_IMESSAGE_SUPABASE_SERVICE_KEY"),
    cubeApiSecret: required(source, "CUBEJS_API_SECRET"),
    runtimeServiceUrl: httpsUrl(required(source, "CODEX_RUNTIME_SERVICE_URL"), "CODEX_RUNTIME_SERVICE_URL"),
    runtimeSigningSecret: signingSecret,
    model: source.ALBERT_IMESSAGE_MODEL?.trim() || "claude-haiku-4-5-20251001",
    effort: "max",
    schedulerEnabled,
    schedulerPollMs: pollSeconds * 1000,
    dailyBriefEnabled,
    dailyBriefPollMs: dailyBriefPollSeconds * 1000,
    dailyBriefModel,
    dailyBriefRefreshMs: dailyBriefRefreshSeconds * 1000,
  });
}
