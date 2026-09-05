/**
 * Heads-up alerts (ADR 0132): deterministic triggers evaluated over the
 * governed Cube views and texted over iMessage the moment the data lands.
 *
 * Shared facts between the web surface (app/dash Alerts tab + /api/alerts),
 * the control-plane repository and the imessage-bridge evaluator. Pure: no
 * I/O, no model. The trigger logic itself lives in triggers.ts.
 */
import { z } from "zod";

export const ALERT_TRIGGER_KEYS = [
  "trading_day",
  "bike_sold",
  "vip_customer",
  "workshop_uncollected",
  "workshop_load",
  "stockout",
  "aged_bike",
  "labour_roster",
  "supplier_bills",
  "cash_integrity",
] as const;
export type AlertTriggerKey = (typeof ALERT_TRIGGER_KEYS)[number];

export const ALERT_DOMAINS = ["Sales", "Customers", "Workshop", "Stock", "People", "Money"] as const;
export type AlertDomain = (typeof ALERT_DOMAINS)[number];

export type AlertTriggerDefinition = Readonly<{
  key: AlertTriggerKey;
  title: string;
  domain: AlertDomain;
  /** A few words under the title on the card. */
  summary: string;
  /** One line: what makes it fire. */
  rule: string;
  /** What a text reads like. Never a governed number: illustrative only. */
  example: string;
  /** Connectors the trigger reads; it is skipped when none is connected. */
  needs: readonly string[];
}>;

export const ALERT_TRIGGER_CATALOGUE: readonly AlertTriggerDefinition[] = Object.freeze([
  {
    key: "trading_day",
    title: "Trading day",
    domain: "Sales",
    summary: "Record days, dead days, quiet months.",
    rule: "A record day, a day the shop was staffed but the till barely moved, or a month that closes at a three-year low.",
    example: "Thursday did $11,994 from 11 sales, your biggest day in 13 months.",
    needs: ["lightspeed-r"],
  },
  {
    key: "bike_sold",
    title: "Bike sold",
    domain: "Sales",
    summary: "Bike sales and service reminders.",
    rule: "A bike over $1,500 or a first-time customer's bike, then the six-week and twelve-month service reminders if they have not been back.",
    example: "A first-time customer bought a $3,100 bike. The free first service falls due around 14 Oct.",
    needs: ["lightspeed-r"],
  },
  {
    key: "vip_customer",
    title: "Big customers",
    domain: "Customers",
    summary: "Big customers back, quiet or new.",
    rule: "A $5k-plus customer buys again after a year away, goes quiet for six months, or crosses $5k or $10k lifetime for the first time.",
    example: "A customer with $8.8k lifetime spend walked back in after 380 days away.",
    needs: ["lightspeed-r"],
  },
  {
    key: "workshop_uncollected",
    title: "Waiting on the customer",
    domain: "Workshop",
    summary: "Jobs waiting on the customer.",
    rule: "A job finished for a week with nothing charged, or an open job past its promised date.",
    example: "19 jobs are sitting Finished with nothing charged, the oldest for 312 days.",
    needs: ["lightspeed-r"],
  },
  {
    key: "workshop_load",
    title: "Workshop load",
    domain: "Workshop",
    summary: "Busy days against the roster.",
    rule: "More bikes promised back on a day than the roster can turn, and a record or unusually quiet intake week.",
    example: "Friday: 6 bikes promised back and one person rostered for 8 hours.",
    needs: ["lightspeed-r", "deputy"],
  },
  {
    key: "stockout",
    title: "Consumable hit zero",
    domain: "Stock",
    summary: "Stocked items hitting zero.",
    rule: "A stocked item with sales in the last 90 days reaches zero on hand.",
    example: "Gear inner wire just hit zero. You use about four a week.",
    needs: ["lightspeed-r"],
  },
  {
    key: "aged_bike",
    title: "Bike on the floor a year",
    domain: "Stock",
    summary: "Bikes a year on the floor.",
    rule: "A bike passes another year in stock, and a new brand that has not sold a unit.",
    example: "The Focus Jam2 6.7 just passed three years on the floor at $4,894 cost.",
    needs: ["lightspeed-r"],
  },
  {
    key: "labour_roster",
    title: "Labour and roster",
    domain: "People",
    summary: "Wages, leave and roster gaps.",
    rule: "Wages over 30% of takings for a week, a leave request waiting, leave approved in the peak, or a trading day with nobody rostered.",
    example: "Labour ran at 34% of takings last week against your usual 22%.",
    needs: ["deputy", "lightspeed-r"],
  },
  {
    key: "supplier_bills",
    title: "Supplier bills",
    domain: "Money",
    summary: "New, odd and overdue bills.",
    rule: "A first bill from a new supplier, a look-alike supplier name, a bill bigger than any before, and Monday's overdue and due-this-week digests.",
    example: "A bill just landed under 'LordGunBicycles' but you already have 'Lordgun'.",
    needs: ["xero"],
  },
  {
    key: "cash_integrity",
    title: "Till and refunds",
    domain: "Money",
    summary: "Till counts, refunds and discounts.",
    rule: "The till uncounted for three trading days, a count out by $50, a refund over $500, a sale below cost, a big stock adjustment, or a heavy discount week.",
    example: "The till has not been counted since 9 Aug, 23 trading days.",
    needs: ["lightspeed-r"],
  },
]);

export const ALERT_TRIGGER_BY_KEY: Readonly<Record<AlertTriggerKey, AlertTriggerDefinition>> = Object.freeze(
  Object.fromEntries(ALERT_TRIGGER_CATALOGUE.map((entry) => [entry.key, entry])) as Record<AlertTriggerKey, AlertTriggerDefinition>,
);

export function isAlertTriggerKey(value: unknown): value is AlertTriggerKey {
  return typeof value === "string" && (ALERT_TRIGGER_KEYS as readonly string[]).includes(value);
}

/** The standing conversation every evaluation runs its turn lease in. */
export const ALERTS_CONVERSATION_TITLE = "Alerts · checks" as const;
/** Sidebar history hides conversations with this prefix (checks are not analyses). */
export const ALERTS_CONVERSATION_TITLE_PREFIX = "Alerts ·" as const;
/** Events packed into one text bubble, and bubbles per evaluation per number. */
export const ALERT_EVENTS_PER_BUBBLE = 4;
export const ALERT_BUBBLES_PER_DELIVERY = 3;
/** A scheduled evaluation re-runs on unchanged data after this long. */
export const ALERT_STALE_DATA_RERUN_MS = 6 * 60 * 60_000;
/** The evaluator's default poll cadence. */
export const ALERT_POLL_DEFAULT_SECONDS = 60;

export const PHONE_E164_PATTERN = /^\+[1-9][0-9]{5,14}$/u;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const alertEventStatuses = ["queued", "sent", "failed", "muted"] as const;
export type AlertEventStatus = (typeof alertEventStatuses)[number];

export const alertEvaluationStatuses = ["queued", "running", "finished", "failed"] as const;
export type AlertEvaluationStatus = (typeof alertEvaluationStatuses)[number];

export const alertResultStatuses = ["fired", "quiet", "waiting", "skipped", "error"] as const;
export type AlertResultStatus = (typeof alertResultStatuses)[number];

/** What one trigger concluded at its last evaluation: the card's "now" line. */
export type AlertResultSummary = Readonly<{
  status: AlertResultStatus;
  line: string;
  metrics?: Readonly<Record<string, string | number | null>>;
  error?: string;
}>;

export const alertResultSummarySchema = z.object({
  status: z.enum(alertResultStatuses),
  line: z.string().max(400),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
  error: z.string().max(400).optional(),
}).passthrough();

export const alertTriggerRowSchema = z.object({
  triggerKey: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/u),
  enabled: z.boolean(),
  recipients: z.array(z.string().regex(PHONE_E164_PATTERN)),
  config: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.string(),
}).passthrough();

export type AlertTriggerRow = Readonly<{
  triggerKey: string;
  enabled: boolean;
  recipients: readonly string[];
  config: Readonly<Record<string, unknown>>;
  updatedAt: string;
}>;

export const alertTriggerStateSchema = z.object({
  triggerKey: z.string(),
  lastEvaluatedAt: z.string(),
  lastResult: z.record(z.string(), z.unknown()).default({}),
  lastFiredAt: z.string().nullable(),
}).passthrough();

export type AlertTriggerState = Readonly<{
  triggerKey: string;
  lastEvaluatedAt: string;
  lastResult: AlertResultSummary | null;
  lastFiredAt: string | null;
}>;

export const alertEventSchema = z.object({
  eventId: z.string().regex(ULID_PATTERN),
  triggerKey: z.string(),
  dedupeKey: z.string(),
  headline: z.string(),
  body: z.string(),
  evidence: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(alertEventStatuses),
  recipients: z.array(z.string()),
  evaluationId: z.string().nullable(),
  firedAt: z.string(),
  deliveredAt: z.string().nullable(),
  error: z.string().nullable(),
}).passthrough();

export type AlertEvent = Readonly<{
  eventId: string;
  triggerKey: string;
  dedupeKey: string;
  headline: string;
  body: string;
  evidence: Readonly<Record<string, unknown>>;
  status: AlertEventStatus;
  recipients: readonly string[];
  evaluationId: string | null;
  firedAt: string;
  deliveredAt: string | null;
  error: string | null;
}>;

export const alertEvaluationSchema = z.object({
  evaluationId: z.string().regex(ULID_PATTERN),
  trigger: z.enum(["schedule", "manual"]),
  status: z.enum(alertEvaluationStatuses),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  freshnessDigest: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()).default({}),
  error: z.string().nullable(),
}).passthrough();

export type AlertEvaluation = Readonly<{
  evaluationId: string;
  trigger: "schedule" | "manual";
  status: AlertEvaluationStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  conversationId: string | null;
  turnId: string | null;
  freshnessDigest: string | null;
  summary: Readonly<Record<string, unknown>>;
  error: string | null;
}>;

export const alertSettingsSchema = z.object({
  cadenceMinutes: z.number().int().min(15).max(1440),
  lastEvaluatedAt: z.string().nullable(),
  lastFreshnessDigest: z.string().nullable(),
}).passthrough();

export type AlertSettings = Readonly<{
  cadenceMinutes: number;
  lastEvaluatedAt: string | null;
  lastFreshnessDigest: string | null;
}>;

export function toAlertTriggerRow(raw: z.infer<typeof alertTriggerRowSchema>): AlertTriggerRow {
  return Object.freeze({
    triggerKey: raw.triggerKey,
    enabled: raw.enabled,
    recipients: Object.freeze([...raw.recipients]),
    config: Object.freeze({ ...raw.config }),
    updatedAt: raw.updatedAt,
  });
}

export function toAlertTriggerState(raw: z.infer<typeof alertTriggerStateSchema>): AlertTriggerState {
  const parsed = alertResultSummarySchema.safeParse(raw.lastResult);
  return Object.freeze({
    triggerKey: raw.triggerKey,
    lastEvaluatedAt: raw.lastEvaluatedAt,
    lastResult: parsed.success
      ? Object.freeze({
        status: parsed.data.status,
        line: parsed.data.line,
        ...(parsed.data.metrics ? { metrics: Object.freeze({ ...parsed.data.metrics }) } : {}),
        ...(parsed.data.error ? { error: parsed.data.error } : {}),
      })
      : null,
    lastFiredAt: raw.lastFiredAt ?? null,
  });
}

export function toAlertEvent(raw: z.infer<typeof alertEventSchema>): AlertEvent {
  return Object.freeze({
    eventId: raw.eventId,
    triggerKey: raw.triggerKey,
    dedupeKey: raw.dedupeKey,
    headline: raw.headline,
    body: raw.body,
    evidence: Object.freeze({ ...raw.evidence }),
    status: raw.status,
    recipients: Object.freeze([...raw.recipients]),
    evaluationId: raw.evaluationId ?? null,
    firedAt: raw.firedAt,
    deliveredAt: raw.deliveredAt ?? null,
    error: raw.error ?? null,
  });
}

export function toAlertEvaluation(raw: z.infer<typeof alertEvaluationSchema>): AlertEvaluation {
  return Object.freeze({
    evaluationId: raw.evaluationId,
    trigger: raw.trigger,
    status: raw.status,
    requestedAt: raw.requestedAt,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    conversationId: raw.conversationId ?? null,
    turnId: raw.turnId ?? null,
    freshnessDigest: raw.freshnessDigest ?? null,
    summary: Object.freeze({ ...raw.summary }),
    error: raw.error ?? null,
  });
}

export function toAlertSettings(raw: z.infer<typeof alertSettingsSchema>): AlertSettings {
  return Object.freeze({
    cadenceMinutes: raw.cadenceMinutes,
    lastEvaluatedAt: raw.lastEvaluatedAt ?? null,
    lastFreshnessDigest: raw.lastFreshnessDigest ?? null,
  });
}

/** An event a trigger wants to fire; the store decides whether it is new. */
export type AlertEventDraft = Readonly<{
  dedupeKey: string;
  headline: string;
  body: string;
  evidence?: Readonly<Record<string, unknown>>;
}>;

/**
 * How one evaluated trigger reads on a phone: a bold headline then the
 * body, in the "Heads up" register the owner asked for.
 */
export function alertEventText(event: Readonly<{ headline: string; body: string }>): Readonly<{
  text: string;
  bold: readonly [number, number];
}> {
  const headline = `Heads up: ${event.headline.trim().replace(/\.$/u, "")}`;
  const text = `${headline}\n${event.body.trim()}`;
  return Object.freeze({ text, bold: [0, headline.length] as const });
}

/**
 * Packs the events of one evaluation into at most ALERT_BUBBLES_PER_DELIVERY
 * text bubbles for one number; the overflow is counted, not sent.
 */
export function packAlertBubbles(
  events: ReadonlyArray<Readonly<{ headline: string; body: string }>>,
): ReadonlyArray<Readonly<{ text: string; bold: ReadonlyArray<readonly [number, number]> }>> {
  const bubbles: Array<{ text: string; bold: Array<readonly [number, number]> }> = [];
  const capacity = ALERT_EVENTS_PER_BUBBLE * ALERT_BUBBLES_PER_DELIVERY;
  const shown = events.slice(0, capacity);
  const overflow = events.length - shown.length;
  for (let index = 0; index < shown.length; index += ALERT_EVENTS_PER_BUBBLE) {
    const group = shown.slice(index, index + ALERT_EVENTS_PER_BUBBLE);
    let text = "";
    const bold: Array<readonly [number, number]> = [];
    for (const event of group) {
      const part = alertEventText(event);
      const offset = text.length === 0 ? 0 : text.length + 2;
      text = text.length === 0 ? part.text : `${text}\n\n${part.text}`;
      bold.push([offset + part.bold[0], offset + part.bold[1]] as const);
    }
    bubbles.push({ text, bold });
  }
  if (overflow > 0 && bubbles.length > 0) {
    const last = bubbles[bubbles.length - 1]!;
    last.text = `${last.text}\n\n…and ${overflow} more in the Alerts tab.`;
  }
  return Object.freeze(bubbles.map((bubble) => Object.freeze({ text: bubble.text, bold: Object.freeze(bubble.bold) })));
}

/** "+61414187820" → "+61 414 187 820"; "+16502831814" → "+1 (650) 283-1814". */
export function formatAlertPhone(phone: string): string {
  if (/^\+614\d{8}$/u.test(phone)) {
    return `+61 ${phone.slice(3, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`;
  }
  if (/^\+1\d{10}$/u.test(phone)) {
    return `+1 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  return phone;
}
