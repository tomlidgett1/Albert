import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";
import type { ScheduledRun } from "../scheduled/src/contracts.js";
import { loadImessageBridgeConfig } from "./src/config.js";
import type { OwnerAnalysisRequest, OwnerAnalysisResult } from "./src/analysis.js";
import {
  ScheduledReportScheduler,
  type ScheduledRunClaim,
  type ScheduledRunOutcome,
  type ScheduledWork,
  type SchedulerStore,
  type SchedulerTask,
} from "./src/scheduler.js";

const OWNER_PHONE = "+61414187820";
const BOT = "+16502831814";

function task(overrides: Partial<SchedulerTask> = {}): SchedulerTask {
  return {
    taskId: "01KZN20VTX2EWW1TQ2AA3MCPW6",
    title: "Yesterday's sales overview",
    requestText: "send me a message every morning at 9am with an overview of yesterday's sales",
    prompt: "How did sales perform yesterday compared with the same day last week?",
    timeOfDay: "09:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    timezone: "Australia/Melbourne",
    phone: OWNER_PHONE,
    enabled: true,
    nextRunAt: "2026-09-01T23:00:00.000Z",
    lastRunAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

type FakeStore = SchedulerStore & {
  claims: ScheduledRunClaim[];
  outcomes: ScheduledRunOutcome[];
  work: ScheduledWork;
  enrolledPhones: string[];
  claimResult: (claim: ScheduledRunClaim) => ScheduledRun | null;
};

function fakeStore(work: ScheduledWork, options: Readonly<{ enrolled?: string[] }> = {}): FakeStore {
  const store: FakeStore = {
    claims: [],
    outcomes: [],
    work,
    enrolledPhones: options.enrolled ?? [OWNER_PHONE],
    claimResult: (claim) => ({
      runId: claim.runId,
      taskId: claim.taskId,
      trigger: claim.trigger,
      status: "running",
      requestedAt: "2026-09-01T23:00:05.000Z",
      startedAt: "2026-09-01T23:00:05.000Z",
      finishedAt: null,
      scheduledFor: claim.trigger === "schedule" ? claim.expectedNextRunAt : null,
      conversationId: null,
      turnId: null,
      answerState: null,
      summary: null,
      error: null,
      bubbles: null,
    }),
    async scheduledWork() {
      const current = store.work;
      store.work = { due: [], queued: [] };
      return current;
    },
    async claimScheduledRun(claim) {
      store.claims.push(claim);
      return store.claimResult(claim);
    },
    async finishScheduledRun(outcome) {
      store.outcomes.push(outcome);
    },
    async imessageWorkspace() {
      return {
        allowGroupChats: false,
        enrollments: store.enrolledPhones.map((phone, index) => ({
          enrollmentId: `enr-${index}`,
          phone,
          displayName: null,
          email: null,
          isOwner: index === 0,
          enabled: true,
          createdAt: "2026-09-01T00:00:00.000Z",
        })),
      };
    },
  };
  return store;
}

function fakeSender() {
  const sent: Array<{ kind: "create" | "send"; to: string; text: string; bold: number }> = [];
  return {
    sent,
    async createChat(_from: string, to: string, text: string, decorations: readonly { style: string }[] = []) {
      sent.push({ kind: "create", to, text, bold: decorations.filter((entry) => entry.style === "bold").length });
      return "chat-1";
    },
    async sendMessage(chatId: string, text: string, decorations: readonly { style: string }[] = []) {
      sent.push({ kind: "send", to: chatId, text, bold: decorations.filter((entry) => entry.style === "bold").length });
    },
  };
}

function analysisReplying(text: string, state = "Verified") {
  const requests: OwnerAnalysisRequest[] = [];
  const runAnalysis = async (request: OwnerAnalysisRequest): Promise<OwnerAnalysisResult> => {
    requests.push(request);
    return {
      conversationId: "01M1C0CFF6GQGXHD49V3FXARPW",
      turnId: "01M1C0CFF6GQGXHD49V3FXARPX",
      answerText: text,
      answerState: state,
      clarification: "",
      followUps: [],
    };
  };
  return { requests, runAnalysis };
}

const quiet = () => undefined;

test("a due schedule is claimed with the following slot, analysed as a standalone report and texted to its number", async () => {
  const store = fakeStore({ due: [task()], queued: [] });
  const sender = fakeSender();
  const analysis = analysisReplying("Sales hit **$12,400** yesterday, up 8% on the same Monday last week.\n---\nBikes led at $8.2k.");
  const scheduler = new ScheduledReportScheduler({
    store,
    sender,
    botNumber: BOT,
    runAnalysis: analysis.runAnalysis,
    pollMs: 60_000,
    log: quiet,
    // 09:00:05 AEST on Wednesday 2 September, five seconds past the slot.
    now: () => new Date("2026-09-01T23:00:05Z"),
  });
  await scheduler.tick();

  assert.equal(store.claims.length, 1);
  const claim = store.claims[0]!;
  assert.equal(claim.trigger, "schedule");
  assert.equal(claim.expectedNextRunAt, "2026-09-01T23:00:00.000Z");
  assert.equal(claim.nextRunAt, "2026-09-02T23:00:00.000Z", "the next slot is tomorrow 09:00 AEST");
  assert.match(claim.runId, /^[0-9A-HJKMNP-TV-Z]{26}$/u);

  assert.equal(analysis.requests.length, 1);
  assert.match(analysis.requests[0]!.question, /^How did sales perform yesterday/u);
  assert.match(analysis.requests[0]!.question, /Scheduled update "Yesterday's sales overview"/u);
  assert.equal(analysis.requests[0]!.newConversationTitle, "Scheduled · Yesterday's sales overview");
  assert.equal(analysis.requests[0]!.conversationId, undefined, "every run is a fresh conversation");

  assert.deepEqual(sender.sent.map((entry) => [entry.kind, entry.to]), [["create", OWNER_PHONE], ["send", "chat-1"]]);
  assert.equal(sender.sent[0]!.text, "Sales hit $12,400 yesterday, up 8% on the same Monday last week.");
  assert.equal(sender.sent[0]!.bold, 1);
  assert.equal(sender.sent[1]!.text, "Bikes led at $8.2k.");

  assert.equal(store.outcomes.length, 1);
  assert.deepEqual(store.outcomes[0], {
    runId: claim.runId,
    status: "sent",
    conversationId: "01M1C0CFF6GQGXHD49V3FXARPW",
    turnId: "01M1C0CFF6GQGXHD49V3FXARPX",
    answerState: "Verified",
    summary: "Sales hit $12,400 yesterday, up 8% on the same Monday last week.",
    bubbles: 2,
  });
  assert.equal(scheduler.status().ticks, 1);
  assert.equal(scheduler.status().lastError, null);
});

test("a queued manual run is claimed as manual, never advances the schedule, and runs before due work", async () => {
  const runId = ulid();
  const queuedRun: ScheduledRun & { task: SchedulerTask } = {
    runId,
    taskId: task().taskId,
    trigger: "manual",
    status: "queued",
    requestedAt: "2026-09-01T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    conversationId: null,
    turnId: null,
    answerState: null,
    summary: null,
    error: null,
    bubbles: null,
    task: task(),
  };
  const store = fakeStore({ due: [task({ taskId: "01KZN20VTX2EWW1TQ2AA3MCPW7" })], queued: [queuedRun] });
  const sender = fakeSender();
  const analysis = analysisReplying("Quiet day: **$3.1k** in sales.");
  const scheduler = new ScheduledReportScheduler({
    store,
    sender,
    botNumber: BOT,
    runAnalysis: analysis.runAnalysis,
    pollMs: 60_000,
    log: quiet,
    now: () => new Date("2026-09-01T23:00:05Z"),
  });
  await scheduler.tick();
  assert.deepEqual(store.claims.map((claim) => claim.trigger), ["manual", "schedule"]);
  assert.equal(store.claims[0]!.runId, runId);
  assert.equal(store.claims[0]!.nextRunAt, null);
  assert.equal(store.claims[0]!.expectedNextRunAt, null);
  assert.equal(store.outcomes.filter((outcome) => outcome.status === "sent").length, 2);
});

test("a claim that misses (edited or already taken) is skipped without analysis or a text", async () => {
  const store = fakeStore({ due: [task()], queued: [] });
  store.claimResult = () => null;
  const sender = fakeSender();
  const analysis = analysisReplying("never");
  const scheduler = new ScheduledReportScheduler({
    store, sender, botNumber: BOT, runAnalysis: analysis.runAnalysis, pollMs: 60_000, log: quiet,
    now: () => new Date("2026-09-01T23:00:05Z"),
  });
  await scheduler.tick();
  assert.equal(store.claims.length, 1);
  assert.equal(analysis.requests.length, 0);
  assert.equal(sender.sent.length, 0);
  assert.equal(store.outcomes.length, 0);
});

test("a slot more than the grace window overdue is recorded as missed, not sent hours late", async () => {
  const store = fakeStore({ due: [task()], queued: [] });
  const sender = fakeSender();
  const analysis = analysisReplying("never");
  const scheduler = new ScheduledReportScheduler({
    store, sender, botNumber: BOT, runAnalysis: analysis.runAnalysis, pollMs: 60_000, log: quiet,
    // 16:00 AEST, seven hours after the 09:00 slot.
    now: () => new Date("2026-09-02T06:00:00Z"),
  });
  await scheduler.tick();
  assert.equal(analysis.requests.length, 0);
  assert.equal(sender.sent.length, 0);
  assert.equal(store.outcomes.length, 1);
  assert.equal(store.outcomes[0]!.status, "missed");
  assert.match(store.outcomes[0]!.error ?? "", /Missed the .*9:00 am slot/u);
  // The schedule still advanced to the next future slot at claim time.
  assert.equal(store.claims[0]!.nextRunAt, "2026-09-02T23:00:00.000Z");
});

test("a number that is no longer enrolled fails the run before any analysis", async () => {
  const store = fakeStore({ due: [task()], queued: [] }, { enrolled: ["+61400000000"] });
  const sender = fakeSender();
  const analysis = analysisReplying("never");
  const scheduler = new ScheduledReportScheduler({
    store, sender, botNumber: BOT, runAnalysis: analysis.runAnalysis, pollMs: 60_000, log: quiet,
    now: () => new Date("2026-09-01T23:00:05Z"),
  });
  await scheduler.tick();
  assert.equal(analysis.requests.length, 0);
  assert.equal(sender.sent.length, 0);
  assert.equal(store.outcomes[0]!.status, "failed");
  assert.match(store.outcomes[0]!.error ?? "", /no longer enrolled/u);
});

test("an analysis failure is recorded and, for a scheduled run, explained to the owner by text", async () => {
  const store = fakeStore({ due: [task()], queued: [] });
  const sender = fakeSender();
  const events: string[] = [];
  const scheduler = new ScheduledReportScheduler({
    store,
    sender,
    botNumber: BOT,
    runAnalysis: async () => { throw new Error("The Omni runtime could not be reached."); },
    pollMs: 60_000,
    log: (event) => { events.push(event); },
    now: () => new Date("2026-09-01T23:00:05Z"),
  });
  await scheduler.tick();
  assert.equal(store.outcomes[0]!.status, "failed");
  assert.match(store.outcomes[0]!.error ?? "", /could not be reached/u);
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0]!.text, /couldn't put together "Yesterday's sales overview"/u);
  assert.ok(events.includes("scheduled_run_failed"));

  // A manual run failure is visible in the tab; no failure text goes out.
  const manualStore = fakeStore({ due: [], queued: [{
    runId: ulid(), taskId: task().taskId, trigger: "manual", status: "queued",
    requestedAt: "2026-09-01T12:00:00.000Z", startedAt: null, finishedAt: null, scheduledFor: null,
    conversationId: null, turnId: null, answerState: null, summary: null, error: null, bubbles: null, task: task(),
  }] });
  const manualSender = fakeSender();
  const manual = new ScheduledReportScheduler({
    store: manualStore, sender: manualSender, botNumber: BOT,
    runAnalysis: async () => { throw new Error("boom"); },
    pollMs: 60_000, log: quiet, now: () => new Date("2026-09-01T23:00:05Z"),
  });
  await manual.tick();
  assert.equal(manualStore.outcomes[0]!.status, "failed");
  assert.equal(manualSender.sent.length, 0);
});

test("a failing work fetch is reported on the status and never stops the loop", async () => {
  const store = fakeStore({ due: [], queued: [] });
  store.scheduledWork = async () => { throw new Error("albert_scheduled_work failed: not deployed (PGRST202)"); };
  const scheduler = new ScheduledReportScheduler({
    store, sender: fakeSender(), botNumber: BOT, runAnalysis: analysisReplying("x").runAnalysis,
    pollMs: 60_000, log: quiet,
  });
  await scheduler.tick();
  assert.match(scheduler.status().lastError ?? "", /PGRST202/u);
  store.scheduledWork = async () => ({ due: [], queued: [] });
  await scheduler.tick();
  assert.equal(scheduler.status().lastError, null);
});

test("the bridge config carries the scheduler switch and poll cadence", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PORT: "8797",
    LINQ_API_TOKEN: "linq-token",
    LINQ_WEBHOOK_SIGNING_SECRET: `whsec_${Buffer.from("t".repeat(32)).toString("base64")}`,
    LINQ_WEBHOOK_URL_TOKEN: "u".repeat(32),
    ALBERT_IMESSAGE_BOT_NUMBER: BOT,
    ALBERT_IMESSAGE_ALLOWED_SENDERS: OWNER_PHONE,
    ALBERT_IMESSAGE_OWNER_EMAIL: "tom@lidgett.net",
    ALBERT_IMESSAGE_SUPABASE_URL: "https://jjiugnriaypjoxsupjft.supabase.co",
    ALBERT_IMESSAGE_SUPABASE_ANON_KEY: "anon",
    ALBERT_IMESSAGE_SUPABASE_SERVICE_KEY: "service",
    CUBEJS_API_SECRET: "cube-secret",
    CODEX_RUNTIME_SERVICE_URL: "https://albert-codex-runtime.fly.dev",
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: "s".repeat(48),
  };
  const defaults = loadImessageBridgeConfig(env);
  assert.equal(defaults.schedulerEnabled, true);
  assert.equal(defaults.schedulerPollMs, 20_000);
  assert.equal(loadImessageBridgeConfig({ ...env, ALBERT_SCHEDULED_ENABLED: "false" }).schedulerEnabled, false);
  assert.equal(loadImessageBridgeConfig({ ...env, ALBERT_SCHEDULED_POLL_SECONDS: "45" }).schedulerPollMs, 45_000);
  assert.throws(() => loadImessageBridgeConfig({ ...env, ALBERT_SCHEDULED_POLL_SECONDS: "2" }));
});
