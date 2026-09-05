import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_BRIEF_CONVERSATION_TITLE,
  DAILY_BRIEF_DEFAULT_WHY,
  dailyBriefDue,
  dailyBriefMessage,
  dailyBriefModelLabel,
  isDailyBriefModel,
  parseDailyBriefAnswer,
} from "../recommended-analysis/src/daily-brief.js";
import { toolForDomain, toolFromLabel, withRecommendedTools } from "../recommended-analysis/src/tools.js";
import type { OwnerAnalysisRequest, OwnerAnalysisResult } from "./src/analysis.js";
import {
  DailyBriefLoop,
  dailyBriefFingerprint,
  type DailyBriefSave,
  type DailyBriefStore,
  type StoredDailyBrief,
} from "./src/daily-brief.js";

const CONNECTORS = ["lightspeed-r", "fivetran-xero", "deputy"] as const;
const MELBOURNE = "Australia/Melbourne";
/** 06:30 on Wed 2 Sep in Melbourne (AEST, UTC+10). */
const MORNING = new Date("2026-09-01T20:30:00.000Z");
const CONVERSATION = "01J00000000000000000000099";
const SOURCE = { conversationId: CONVERSATION, title: "Daily look · Wed 2 Sep" } as const;

const ANSWER = [
  "**Verdict:** Takings held up yesterday but labour ran heavy and one big bill landed.",
  "- [Lightspeed] Tuesday took $4,120, 31% below the last four Tuesdays — which categories fell? — bikes carried the drop.",
  "- **[Deputy]** Labour ran at 38% of takings yesterday against a usual 27%: was the roster right for a quiet Tuesday? — three more hours rostered than usual",
  "- [Xero] A $6,400 bill from Shimano landed, the largest this quarter — is it the pre-season order?",
  "",
  "[Which categories fell?](?ai-query=Which%20categories%20fell)",
].join("\n");

test("the daily look is due once per local day from the configured hour", () => {
  assert.equal(dailyBriefDue({ now: MORNING, timezone: MELBOURNE, lastGeneratedAt: null }), true);
  // Stored yesterday morning: today's look is due.
  assert.equal(dailyBriefDue({ now: MORNING, timezone: MELBOURNE, lastGeneratedAt: "2026-08-31T20:10:00.000Z" }), true);
  // Stored at 06:05 today: not again today.
  assert.equal(dailyBriefDue({ now: MORNING, timezone: MELBOURNE, lastGeneratedAt: "2026-09-01T20:05:00.000Z" }), false);
  // 05:30 local is before the hour, even with nothing stored.
  assert.equal(dailyBriefDue({ now: new Date("2026-09-01T19:30:00.000Z"), timezone: MELBOURNE, lastGeneratedAt: null }), false);
  // A bridge that was down at six catches up at three in the afternoon.
  assert.equal(dailyBriefDue({ now: new Date("2026-09-02T05:00:00.000Z"), timezone: MELBOURNE, lastGeneratedAt: "2026-08-31T20:10:00.000Z" }), true);
  assert.equal(dailyBriefDue({ now: MORNING, timezone: MELBOURNE, lastGeneratedAt: null, fromHour: 9 }), false);
  assert.equal(isDailyBriefModel(dailyBriefModelLabel("gpt-5.6-luna")), true);
  assert.equal(isDailyBriefModel("gpt-5.6-luna"), false);
  assert.equal(isDailyBriefModel("playbook"), false);
});

test("the daily message names the window, the connected tools and the answer shape", () => {
  const message = dailyBriefMessage({
    now: MORNING,
    timezone: MELBOURNE,
    connectorKeys: [...CONNECTORS],
    freshness: [
      { connector: "lightspeed-r", domain: "sales", dataThrough: "2026-09-02T08:05:00.000Z" },
      { connector: "fivetran-xero", domain: "finance", dataThrough: null },
    ],
  });
  assert.match(message, /Data reaches: Lightspeed sales to Wed 2 Sept?, 6:05 pm; Xero finance: no data yet\./u);
  assert.match(message, /Missing data, empty results and sync state are never a finding/u);
  assert.match(message, /last 24 hours \(from Tue 1 Sept?, 6:30 am to Wed 2 Sept?, 6:30 am, Australia\/Melbourne\)/u);
  assert.match(message, /across Lightspeed, Xero and Deputy/u);
  assert.match(message, /^Verdict: /mu);
  assert.match(message, /^- \[Tool\] /mu);
  assert.match(message, /\(Lightspeed, Xero or Deputy\)/u);
  assert.match(message, /if nothing stands out, say so and list nothing/u);
});

test("the daily answer is read back into rows with the tool each figure came from", () => {
  const parsed = parseDailyBriefAnswer({ text: ANSWER, connectorKeys: [...CONNECTORS], source: SOURCE });
  assert.equal(parsed.verdict, "Takings held up yesterday but labour ran heavy and one big bill landed.");
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.items.map((item) => item.tool), ["lightspeed", "deputy", "xero"]);
  assert.equal(parsed.items[0]!.question, "Tuesday took $4,120, 31% below the last four Tuesdays — which categories fell?");
  assert.equal(parsed.items[0]!.why, "bikes carried the drop.");
  assert.equal(parsed.items[1]!.domain, "staff");
  assert.equal(parsed.items[1]!.why, "three more hours rostered than usual");
  assert.equal(parsed.items[2]!.why, DAILY_BRIEF_DEFAULT_WHY);
  for (const item of parsed.items) {
    assert.equal(item.fromConversationId, CONVERSATION);
    assert.equal(item.fromTitle, "Daily look · Wed 2 Sep");
    assert.match(item.id, /^daily-\d-[0-9a-f]{5}$/u);
    assert.ok(item.why.length >= 8);
  }
});

test("an answer that ignored the shape falls back to the harness follow-ups, and template echoes are dropped", () => {
  const text = [
    "Verdict: one sentence, at most 28 words, on the last 24 hours as a whole.",
    "- [Tool] One sentence, at most 24 words, that states what happened with its figure and asks the question I should look at next? — a few words on why it matters.",
    "Nothing stood out yesterday: takings, labour and cash all sat inside their usual range.",
  ].join("\n");
  const parsed = parseDailyBriefAnswer({
    text,
    followUps: ["How did yesterday compare with the same Tuesday last year", "Which supplier bills are due this week?"],
    connectorKeys: [...CONNECTORS],
    source: { conversationId: null, title: "Daily look · Wed 2 Sep" },
  });
  assert.equal(parsed.verdict, "Nothing stood out yesterday: takings, labour and cash all sat inside their usual range.");
  assert.deepEqual(
    parsed.items.map((item) => item.question),
    ["How did yesterday compare with the same Tuesday last year?", "Which supplier bills are due this week?"],
  );
  assert.equal(parsed.items[0]!.tool, "lightspeed");
  assert.equal(parsed.items[0]!.why, DAILY_BRIEF_DEFAULT_WHY);
});

test("nothing interesting is a verdict with no rows", () => {
  const parsed = parseDailyBriefAnswer({
    text: "Verdict: An ordinary Tuesday — takings, labour and bank movements all sat inside their usual range.",
    connectorKeys: [...CONNECTORS],
    source: SOURCE,
  });
  assert.equal(parsed.items.length, 0);
  assert.match(parsed.verdict, /ordinary Tuesday/u);
});

test("tools resolve from the model's label or the domain, only among connected tools", () => {
  assert.equal(toolFromLabel("Lightspeed Retail", [...CONNECTORS]), "lightspeed");
  assert.equal(toolFromLabel("xero", [...CONNECTORS]), "xero");
  assert.equal(toolFromLabel("Square", [...CONNECTORS]), null);
  assert.equal(toolForDomain("cash", ["lightspeed-r"]), "lightspeed");
  assert.equal(toolForDomain("staff", ["lightspeed-r", "xero"]), "lightspeed");
  assert.equal(toolForDomain("staff", [...CONNECTORS]), "deputy");
  assert.equal(toolForDomain("cash", [...CONNECTORS]), "xero");
  assert.equal(toolForDomain("workshop", ["xero"]), null);
  const rows = withRecommendedTools([{
    id: "rec-1-cash0",
    question: "Did last week's takings reach the bank?",
    why: "You reviewed sales, but not whether that cash landed.",
    move: "close_the_loop",
    domain: "cash",
    fromTitle: "Weekly sales trend",
    fromConversationId: null,
  }], [...CONNECTORS]);
  assert.equal(rows[0]!.tool, "xero");
  assert.match(dailyBriefFingerprint({ tenantId: "t", conversationId: "c", turnId: "u" }), /^[0-9a-f]{64}$/u);
});

type FakeStore = DailyBriefStore & {
  saves: DailyBriefSave[];
  stored: StoredDailyBrief | null;
  existing: string | null;
};

function fakeStore(stored: StoredDailyBrief | null, clock: Date, connectors: readonly string[] = CONNECTORS): FakeStore {
  const store: FakeStore = {
    saves: [],
    stored,
    existing: null,
    async tenantContext() {
      return { tenant_id: "01KZN20VTX2EWW1TQ2AA3MCPW6", tenant_name: "Ashburton Cycles", role: "owner", timezone: MELBOURNE };
    },
    async connectorRouting() {
      return { activeConnectors: connectors };
    },
    async findConversationByTitle(title) {
      return title === DAILY_BRIEF_CONVERSATION_TITLE ? store.existing : null;
    },
    async recommendedAnalysis() {
      return store.stored;
    },
    async saveRecommendedAnalysis(input) {
      store.saves.push(input);
      store.stored = { model: input.model, generatedAt: clock.toISOString(), itemCount: input.recommendations.length };
    },
  };
  return store;
}

function analysis(overrides: Partial<OwnerAnalysisResult> = {}): OwnerAnalysisResult {
  return {
    conversationId: CONVERSATION,
    turnId: "01J000000000000000000000T1",
    answerText: ANSWER,
    answerState: "Verified",
    clarification: "",
    followUps: [],
    ...overrides,
  };
}

test("the loop runs today's look once, stores it as omni:<model> with tools, and reuses the standing conversation", async () => {
  const store = fakeStore(null, MORNING);
  store.existing = CONVERSATION;
  const requests: OwnerAnalysisRequest[] = [];
  const loop = new DailyBriefLoop({
    store,
    runAnalysis: async (request) => {
      requests.push(request);
      return analysis();
    },
    model: "gpt-5.6-luna",
    effort: "max",
    fromHour: 6,
    pollMs: 60_000,
    log: () => undefined,
    now: () => MORNING,
  });
  await loop.tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.conversationId, CONVERSATION);
  assert.equal(requests[0]!.newConversationTitle, undefined);
  assert.equal(requests[0]!.model, "gpt-5.6-luna");
  assert.equal(requests[0]!.effort, "max");
  assert.equal(requests[0]!.channel, null);
  assert.equal(requests[0]!.kind, "daily_brief");
  assert.match(requests[0]!.question, /last 24 hours/u);
  assert.equal(store.saves.length, 1);
  const save = store.saves[0]!;
  assert.equal(save.model, "omni:gpt-5.6-luna");
  assert.equal(save.sourceCount, 3);
  assert.match(save.sourceFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(save.verdict, "Takings held up yesterday but labour ran heavy and one big bill landed.");
  assert.deepEqual(save.recommendations.map((item) => item.tool), ["lightspeed", "deputy", "xero"]);
  assert.equal(save.recommendations[0]!.fromConversationId, CONVERSATION);
  // Same day: nothing more to do.
  await loop.tick();
  assert.equal(requests.length, 1);
  assert.equal(loop.status().lastRunAt, MORNING.toISOString());
  assert.equal(loop.status().lastError, null);
});

test("the first look opens the standing conversation; no connected tools means no look", async () => {
  const store = fakeStore(null, MORNING);
  const requests: OwnerAnalysisRequest[] = [];
  const loop = new DailyBriefLoop({
    store,
    runAnalysis: async (request) => {
      requests.push(request);
      return analysis({ conversationId: "01J000000000000000000000A1" });
    },
    model: "gpt-5.6-luna",
    effort: "max",
    fromHour: 6,
    pollMs: 60_000,
    log: () => undefined,
    now: () => MORNING,
  });
  await loop.tick();
  assert.equal(requests[0]!.conversationId, undefined);
  assert.equal(requests[0]!.newConversationTitle, DAILY_BRIEF_CONVERSATION_TITLE);
  assert.equal(store.saves[0]!.recommendations[0]!.fromConversationId, "01J000000000000000000000A1");

  const bare = fakeStore(null, MORNING, []);
  const idle = new DailyBriefLoop({
    store: bare,
    runAnalysis: async () => {
      throw new Error("should not run without tools");
    },
    model: "gpt-5.6-luna",
    effort: "max",
    fromHour: 6,
    pollMs: 60_000,
    log: () => undefined,
    now: () => MORNING,
  });
  await idle.tick();
  assert.equal(bare.saves.length, 0);
  assert.equal(idle.status().lastError, null);
});

test("a chat-history brief does not count as today's look, and a failed look waits before retrying", async () => {
  const store = fakeStore({ model: "gpt-5.6-luna", generatedAt: MORNING.toISOString(), itemCount: 3 }, MORNING);
  let calls = 0;
  const loop = new DailyBriefLoop({
    store,
    runAnalysis: async () => {
      calls += 1;
      throw new Error("runtime down");
    },
    model: "gpt-5.6-luna",
    effort: "max",
    fromHour: 6,
    pollMs: 60_000,
    retryMs: 30 * 60_000,
    log: () => undefined,
    now: () => MORNING,
  });
  await loop.tick();
  assert.equal(calls, 1);
  assert.match(loop.status().lastError ?? "", /runtime down/u);
  await loop.tick();
  assert.equal(calls, 1, "inside the retry window the loop does not try again");
  assert.equal(store.saves.length, 0);
});

test("a clarification instead of an answer is a failure, not a stored brief", async () => {
  const store = fakeStore(null, MORNING);
  const loop = new DailyBriefLoop({
    store,
    runAnalysis: async () => analysis({ answerText: "", answerState: "Clarification", clarification: "Which store?\n1. Ashburton" }),
    model: "gpt-5.6-luna",
    effort: "max",
    fromHour: 6,
    pollMs: 60_000,
    log: () => undefined,
    now: () => MORNING,
  });
  await loop.tick();
  assert.equal(store.saves.length, 0);
  assert.match(loop.status().lastError ?? "", /clarifying question/u);
});
