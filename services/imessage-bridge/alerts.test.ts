import assert from "node:assert/strict";
import test from "node:test";
import type { AlertEvaluation, AlertEvent } from "../alerts/src/contracts.js";
import { freshnessDigest } from "../alerts/src/evaluate.js";
import type { AlertTrigger } from "../alerts/src/triggers.js";
import {
  AlertsEvaluatorLoop,
  inQuietHours,
  resolveAlertRecipients,
  type AlertEvaluationClaim,
  type AlertEvaluationOutcome,
  type AlertRecordInput,
  type AlertsStore,
  type AlertsWork,
} from "./src/alerts.js";

const OWNER = "+61414187820";
const SAM = "+61400000002";
const BOT = "+16502831814";

function workspace(phones: readonly string[] = [OWNER, SAM]) {
  return {
    allowGroupChats: false,
    enrollments: phones.map((phone, index) => ({
      enrollmentId: `enr-${index}`,
      phone,
      displayName: null,
      email: null,
      isOwner: index === 0,
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
    })),
  };
}

function evaluation(id: string, trigger: "schedule" | "manual", status: AlertEvaluation["status"]): AlertEvaluation {
  return {
    evaluationId: id,
    trigger,
    status,
    requestedAt: "2026-09-02T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    conversationId: null,
    turnId: null,
    freshnessDigest: null,
    summary: {},
    error: null,
  };
}

type FakeStore = AlertsStore & {
  claims: AlertEvaluationClaim[];
  records: AlertRecordInput[];
  finishedEvents: Array<{ eventId: string; status: "sent" | "failed"; error?: string }>;
  outcomes: AlertEvaluationOutcome[];
  turns: Array<{ conversationId: string; turnId: string; failureCode: string }>;
  renewals: number;
  work: AlertsWork;
  existingConversation: string | null;
};

function fakeStore(work: AlertsWork, options: Readonly<{ phones?: readonly string[]; existingConversation?: string | null }> = {}): FakeStore {
  let eventSequence = 0;
  const store: FakeStore = {
    claims: [],
    records: [],
    finishedEvents: [],
    outcomes: [],
    turns: [],
    renewals: 0,
    work,
    existingConversation: options.existingConversation ?? null,
    async alertsWork() {
      return store.work;
    },
    async claimAlertEvaluation(claim) {
      store.claims.push(claim);
      return { ...evaluation(claim.evaluationId, claim.trigger, "running"), conversationId: claim.conversationId, turnId: claim.turnId };
    },
    async recordAlertResult(input) {
      store.records.push(input);
      return input.events.map((event): AlertEvent => ({
        eventId: `01M1J8SH1E7AVRXB26JA39S6${String(eventSequence++).padStart(2, "0")}`,
        triggerKey: input.triggerKey,
        dedupeKey: event.dedupeKey,
        headline: event.headline,
        body: event.body,
        evidence: event.evidence ?? {},
        status: event.recipients.length === 0 ? "muted" : "queued",
        recipients: event.recipients,
        evaluationId: input.evaluationId,
        firedAt: "2026-09-02T00:00:01.000Z",
        deliveredAt: null,
        error: null,
      }));
    },
    async finishAlertEvent(input) {
      store.finishedEvents.push(input);
    },
    async finishAlertEvaluation(outcome) {
      store.outcomes.push(outcome);
    },
    async imessageWorkspace() {
      return workspace(options.phones);
    },
    async tenantContext() {
      return { tenant_id: "01KZN20VTX2EWW1TQ2AA3MCPW6", tenant_name: "Ashburton Cycles", role: "owner", timezone: "Australia/Melbourne" };
    },
    async connectorRouting() {
      return {
        activeConnectors: ["lightspeed-r", "deputy", "xero"],
        freshness: [{ connector: "lightspeed-r", domain: "sales", dataThrough: "2026-09-01T23:00:00.000Z" }],
      };
    },
    async findConversationByTitle() {
      return store.existingConversation;
    },
    async beginTurn(input) {
      return input.conversationId ?? "01M1C0CFF6GQGXHD49V3FXARPW";
    },
    async releaseRunningTurns() {},
    async assignConversationTitle() {},
    async renewTurnLease() {
      store.renewals += 1;
    },
    async failTurn(conversationId, turnId, failureCode) {
      store.turns.push({ conversationId, turnId, failureCode });
    },
  };
  return store;
}

function fakeSender(options: Readonly<{ failFor?: string }> = {}) {
  const sent: Array<{ kind: "create" | "send"; to: string; text: string; bold: number }> = [];
  return {
    sent,
    async createChat(_from: string, to: string, text: string, decorations: readonly { style: string }[] = []) {
      if (options.failFor === to) throw new Error("Linq API 500: nope");
      sent.push({ kind: "create", to, text, bold: decorations.filter((entry) => entry.style === "bold").length });
      return `chat-${to}`;
    },
    async sendMessage(chatId: string, text: string, decorations: readonly { style: string }[] = []) {
      sent.push({ kind: "send", to: chatId, text, bold: decorations.filter((entry) => entry.style === "bold").length });
    },
  };
}

const firing: AlertTrigger = {
  key: "trading_day",
  async run() {
    return {
      result: { status: "fired", line: "Thu 27 Aug: $11,994 from 11 sales" },
      events: [
        { dedupeKey: "record:2026-08-27", headline: "Biggest day in a year", body: "Thu 27 Aug did $11,994 from 11 sales." },
        { dedupeKey: "dead:2026-08-26", headline: "Staffed, but the till barely moved", body: "Wed 26 Aug: 9 staff hours and $10." },
      ],
    };
  },
};

const quiet: AlertTrigger = {
  key: "stockout",
  async run(_context, load) {
    await load("items at zero with recent sales", { measures: ["inventory_analytics.units_sold_90d"] });
    return { result: { status: "quiet", line: "0 stocked items at zero" }, events: [] };
  },
};

function loop(store: FakeStore, sender = fakeSender(), options: Partial<ConstructorParameters<typeof AlertsEvaluatorLoop>[0]> = {}) {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const evaluator = new AlertsEvaluatorLoop({
    store,
    sender,
    botNumber: BOT,
    pollMs: 60_000,
    quietHours: { from: 21, to: 7 },
    log: (event, fields) => logs.push({ event, fields }),
    triggers: [firing, quiet],
    queryLoader: () => async () => [],
    runtimeProfile: { runtime: "omni-agent", kind: "alerts_evaluation" },
    now: () => new Date("2026-09-02T00:30:00.000Z"),
    ...options,
  });
  return { evaluator, logs };
}

const settings = { cadenceMinutes: 60, lastEvaluatedAt: null, lastFreshnessDigest: null };

test("a requested check runs under a turn lease, records every reading, texts the owner and finishes the evaluation", async () => {
  const store = fakeStore({ queued: evaluation("01M1J8SH1E7AVRXB26JA39S6GT", "manual", "queued"), due: false, settings, triggers: [] });
  const sender = fakeSender();
  const { evaluator } = loop(store, sender);
  await evaluator.tick();

  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0]!.trigger, "manual");
  assert.equal(store.claims[0]!.conversationId, "01M1C0CFF6GQGXHD49V3FXARPW");
  assert.deepEqual(store.records.map((record) => record.triggerKey), ["trading_day", "stockout"]);
  assert.deepEqual(store.records[0]!.events.map((event) => event.recipients), [[OWNER], [OWNER]]);
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0]!.to, OWNER);
  assert.match(sender.sent[0]!.text, /^Heads up: Biggest day in a year\nThu 27 Aug did \$11,994 from 11 sales\.\n\nHeads up: Staffed, but the till barely moved/u);
  assert.equal(sender.sent[0]!.bold, 2);
  assert.deepEqual(store.finishedEvents.map((event) => event.status), ["sent", "sent"]);
  assert.equal(store.outcomes.length, 1);
  assert.equal(store.outcomes[0]!.status, "finished");
  assert.equal(store.outcomes[0]!.summary.fired, 2);
  assert.equal(store.outcomes[0]!.summary.delivered, 2);
  assert.equal(store.outcomes[0]!.summary.evaluated, 2);
  assert.equal(store.outcomes[0]!.freshnessDigest, freshnessDigest([{ connector: "lightspeed-r", domain: "sales", dataThrough: "2026-09-01T23:00:00.000Z" }]));
  assert.deepEqual(store.turns.map((turn) => turn.failureCode), ["albert_alerts_evaluated"]);
  assert.equal(evaluator.status().lastEvaluationAt, "2026-09-02T00:30:00.000Z");
});

test("stored rows decide the switch and the recipients; a disabled trigger is not evaluated and a muted event is not texted", async () => {
  const store = fakeStore({
    queued: evaluation("01M1J8SH1E7AVRXB26JA39S6GT", "manual", "queued"),
    due: false,
    settings,
    triggers: [
      { triggerKey: "trading_day", enabled: true, recipients: [SAM, "+61499999999"], config: {}, updatedAt: "2026-09-01T00:00:00.000Z" },
      { triggerKey: "stockout", enabled: false, recipients: [OWNER], config: {}, updatedAt: "2026-09-01T00:00:00.000Z" },
    ],
  });
  const sender = fakeSender();
  const { evaluator } = loop(store, sender);
  await evaluator.tick();
  assert.deepEqual(store.records.map((record) => record.triggerKey), ["trading_day"]);
  // The unenrolled number is dropped; Sam receives the text.
  assert.deepEqual(store.records[0]!.events[0]!.recipients, [SAM]);
  assert.equal(sender.sent[0]!.to, SAM);

  const resolved = resolveAlertRecipients({ rows: [], workspace: workspace([OWNER, SAM]) });
  assert.deepEqual(resolved.get("trading_day"), { enabled: true, recipients: [OWNER] });
  const none = resolveAlertRecipients({ rows: [{ triggerKey: "trading_day", enabled: true, recipients: [], config: {}, updatedAt: "" }], workspace: workspace() });
  assert.deepEqual(none.get("trading_day"), { enabled: true, recipients: [] });
});

test("a scheduled evaluation waits for new data, honours quiet hours, and a delivery failure marks the event failed", async () => {
  const digest = freshnessDigest([{ connector: "lightspeed-r", domain: "sales", dataThrough: "2026-09-01T23:00:00.000Z" }]);
  const unchanged = fakeStore({
    queued: null,
    due: true,
    settings: { cadenceMinutes: 60, lastEvaluatedAt: "2026-09-01T23:00:00.000Z", lastFreshnessDigest: digest },
    triggers: [],
  });
  await loop(unchanged).evaluator.tick();
  assert.equal(unchanged.claims.length, 0, "unchanged data within six hours is not re-evaluated");

  const stale = fakeStore({
    queued: null,
    due: true,
    settings: { cadenceMinutes: 60, lastEvaluatedAt: "2026-09-01T10:00:00.000Z", lastFreshnessDigest: digest },
    triggers: [],
  });
  await loop(stale).evaluator.tick();
  assert.equal(stale.claims.length, 1, "unchanged data older than six hours is re-evaluated");
  assert.equal(stale.claims[0]!.trigger, "schedule");

  const night = fakeStore({ queued: null, due: true, settings, triggers: [] });
  // 23:30 in Melbourne.
  await loop(night, fakeSender(), { now: () => new Date("2026-09-02T13:30:00.000Z") }).evaluator.tick();
  assert.equal(night.claims.length, 0, "scheduled evaluations sleep through quiet hours");
  assert.ok(inQuietHours(23, { from: 21, to: 7 }));
  assert.ok(inQuietHours(3, { from: 21, to: 7 }));
  assert.ok(!inQuietHours(12, { from: 21, to: 7 }));
  assert.ok(!inQuietHours(21, { from: 9, to: 17 }));

  const failing = fakeStore({ queued: evaluation("01M1J8SH1E7AVRXB26JA39S6GT", "manual", "queued"), due: false, settings, triggers: [] });
  await loop(failing, fakeSender({ failFor: OWNER })).evaluator.tick();
  assert.deepEqual(failing.finishedEvents.map((event) => event.status), ["failed", "failed"]);
  assert.match(failing.finishedEvents[0]!.error ?? "", /Linq API 500/u);
  assert.equal(failing.outcomes[0]!.status, "finished");
  assert.equal(failing.outcomes[0]!.summary.deliveryFailures, 2);
});
