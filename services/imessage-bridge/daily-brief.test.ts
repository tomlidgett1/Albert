import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_BRIEF_CONVERSATION_TITLE,
  DAILY_BRIEF_REFRESH_MS,
  dailyBriefWindow,
  dailyBriefAsk,
  isFreshDailyBrief,
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
  "- [Lightspeed] Sales slowed despite more customers visiting | Which categories explain the lower sales in the last 24 hours? | Takings were $4,120, 31% below comparable weekday windows.",
  "- **[Deputy]** Staffing costs outpaced a quieter trading day | How did worked hours compare with demand in the last 24 hours? | Labour was 38% of takings against a usual 27% in comparable windows.",
  "- [Xero] A large supplier bill needs reviewing | What explains the unusual supplier bill raised in the last 24 hours? | A $6,400 bill was the largest supplier bill this quarter.",
  "",
  "[Which categories fell?](?ai-query=Which%20categories%20fell)",
].join("\n");

test("rolling looks refresh hourly, including overnight and after downtime", () => {
  assert.equal(dailyBriefDue({ now: MORNING, lastGeneratedAt: null }), true);
  for (const age of [0, DAILY_BRIEF_REFRESH_MS - 1]) {
    assert.equal(dailyBriefDue({ now: MORNING, lastGeneratedAt: new Date(+MORNING - age).toISOString() }), false);
  }
  for (const age of [DAILY_BRIEF_REFRESH_MS, 6 * 86_400_000]) {
    assert.equal(dailyBriefDue({ now: MORNING, lastGeneratedAt: new Date(+MORNING - age).toISOString() }), true);
  }
  assert.equal(dailyBriefDue({ now: new Date("2026-09-01T19:30:00Z"), lastGeneratedAt: null }), true);
  assert.equal(dailyBriefDue({ now: MORNING, lastGeneratedAt: "invalid" }), true);
  assert.equal(dailyBriefDue({ now: MORNING, lastGeneratedAt: new Date(+MORNING + 1).toISOString() }), true);
  assert.equal(isDailyBriefModel(dailyBriefModelLabel("gpt-5.6-luna")), true);
});

test("freshness binds the observation window, not just when an old brief was saved", () => {
  const base = { model: dailyBriefModelLabel("gpt-5.6-luna"), generatedAt: MORNING.toISOString(), ...dailyBriefWindow(MORNING) };
  assert.equal(isFreshDailyBrief(base, MORNING), true);
  assert.equal(isFreshDailyBrief(base, new Date(+MORNING + 7_200_000 - 1)), true);
  assert.equal(isFreshDailyBrief(base, new Date(+MORNING + 7_200_000)), false);
  assert.equal(isFreshDailyBrief({ ...base, model: "omni:gpt-5.6-luna" }, MORNING), false);
  assert.equal(isFreshDailyBrief({ ...base, windowStart: null }, MORNING), false);
  assert.equal(isFreshDailyBrief({ ...base, windowEnd: "invalid" }, MORNING), false);
  assert.equal(isFreshDailyBrief({ ...base, ...dailyBriefWindow(new Date(+MORNING - 86_400_000)) }, MORNING), false);
  assert.equal(isFreshDailyBrief({ ...base, ...dailyBriefWindow(new Date(+MORNING + 1)) }, MORNING), false);
});

test("the prompt fixes the current window and requires comparable, material evidence", () => {
  const message = dailyBriefMessage({ now: MORNING, timezone: MELBOURNE, connectorKeys: CONNECTORS });
  assert.match(message, /last 24 hours/u);
  assert.match(message, /2026-08-31T20:30:00.000Z, 2026-09-01T20:30:00.000Z/u);
  assert.match(message, /Do not move it backwards/u);
  assert.match(message, /Never compare a partial day with whole days/u);
  assert.match(message, /Stock risk requires current stock or cover evidence/u);
  assert.match(message, /Missing data, empty results and sync state are never a finding/u);
  assert.match(message, /no figures, acronyms/u);
  assert.match(message, /if nothing stands out, say so and list nothing/u);
});

test("display headlines are separate from grounded evidence and the complete follow-up", () => {
  const parsed = parseDailyBriefAnswer({ text: ANSWER, connectorKeys: CONNECTORS, source: SOURCE });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.items.map(item => item.tool), ["lightspeed", "deputy", "xero"]);
  assert.equal(parsed.items[0]!.title, "Sales slowed despite more customers visiting");
  assert.equal(parsed.items[1]!.domain, "staff");
  for (const item of parsed.items) {
    assert.doesNotMatch(item.title!, /[0-9$%]/u);
    assert.match(item.question, /\?$/u);
    assert.equal(item.fromConversationId, CONVERSATION);
  }
  const ask = dailyBriefAsk(parsed.items[0]!, { ...dailyBriefWindow(MORNING), timezone: MELBOURNE });
  assert.match(ask, /Which categories explain/u);
  assert.match(ask, /2026-08-31T20:30:00.000Z to 2026-09-01T20:30:00.000Z/u);
  assert.match(ask, /\$4,120/u);
});

test("quiet days never turn generic follow-ups into observations", () => {
  const parsed = parseDailyBriefAnswer({ text: "Verdict: Nothing unusual stood out in the last 24 hours.", followUps: ["Which bills are due this week?"], connectorKeys: CONNECTORS, source: SOURCE });
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.items, []);
});

test("dense legacy rows, invented sources and malformed output cannot publish", () => {
  for (const text of [
    "Verdict: Review sales.\n- [Lightspeed] Takings were $1,108 from 19 transactions; should we investigate? — baskets collapsed",
    "Verdict: Review sales.\n- [Square] Sales slowed through the day | Why did sales slow yesterday? | Sales were $1,108 against $2,000.",
    "Verdict: Review sales.\n- [Lightspeed] Sales fell 19% yesterday | Why did sales slow yesterday? | Sales were $1,108 against $2,000.",
    "The analysis could not be completed.",
  ]) {
    const parsed = parseDailyBriefAnswer({ text, followUps: ["What should we review next?"], connectorKeys: CONNECTORS, source: SOURCE });
    assert.equal(parsed.valid, false, text);
    assert.deepEqual(parsed.items, []);
  }
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
      store.stored = { model: input.model, generatedAt: clock.toISOString(), itemCount: input.recommendations.length, windowStart: input.windowStart, windowEnd: input.windowEnd };
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
  assert.equal(save.model, dailyBriefModelLabel("gpt-5.6-luna"));
  assert.equal(requests[0]!.freshContext, true);
  assert.deepEqual({ windowStart: save.windowStart, windowEnd: save.windowEnd }, dailyBriefWindow(MORNING));
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
    pollMs: 60_000,
    log: () => undefined,
    now: () => MORNING,
  });
  await loop.tick();
  assert.equal(store.saves.length, 0);
  assert.match(loop.status().lastError ?? "", /clarifying question/u);
});

test("a failed refresh recovers after backoff and a later hour gets new evidence", async () => {
  let time = new Date(MORNING);
  const store = fakeStore(null, time);
  let calls = 0;
  const loop = new DailyBriefLoop({ store, runAnalysis: async () => {
    calls += 1;
    if (calls === 1) throw new Error("runtime mismatch");
    return analysis();
  }, model: "gpt-5.6-luna", effort: "max", pollMs: 300_000, now: () => time, log: () => undefined });
  await loop.tick();
  assert.equal(store.saves.length, 0);
  time = new Date(+MORNING + 30 * 60_000);
  await loop.tick();
  assert.equal(store.saves.length, 1);
  assert.equal(loop.status().lastError, null);
  assert.equal(store.saves[0]!.windowEnd, time.toISOString());
  time = new Date(+time + DAILY_BRIEF_REFRESH_MS);
  await loop.tick();
  assert.equal(store.saves.length, 2);
  assert.equal(store.saves[1]!.windowEnd, time.toISOString());
});

test("an unavailable answer cannot replace a previously good look", async () => {
  const store = fakeStore(null, MORNING);
  const loop = new DailyBriefLoop({ store, runAnalysis: async () => analysis({ answerText: "Verdict: No evidence was available.", answerState: "Unavailable" }), model: "gpt-5.6-luna", effort: "max", pollMs: 300_000, log: () => undefined, now: () => MORNING });
  await loop.tick();
  assert.equal(store.saves.length, 0);
  assert.match(loop.status().lastError ?? "", /valid, evidence-backed/u);
});
