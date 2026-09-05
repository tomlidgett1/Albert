import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPlaybookVerdict,
  buildAnalysisCorpus,
} from "../../services/recommended-analysis/src/corpus.ts";
import {
  buildPlaybookRecommendations,
  collectAskedQuestions,
  connectorHints,
  makeSelfContained,
  normalizeQuestion,
  type AnalysisBrief,
  type CoverageThread,
} from "../../services/recommended-analysis/src/playbook.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function brief(overrides: Partial<AnalysisBrief> & Pick<AnalysisBrief, "conversationId" | "title" | "userQuestion">): AnalysisBrief {
  return {
    updatedAt: "2026-08-21T04:00:00.000Z",
    turnId: `${overrides.conversationId.slice(0, 25)}T`,
    answerState: "verified",
    completedAt: "2026-08-21T04:01:00.000Z",
    answerExcerpt: "",
    followUps: [],
    keyInsights: [],
    claims: [],
    askedQuestions: [overrides.userQuestion],
    ...overrides,
  };
}

const bikeShopBriefs: readonly AnalysisBrief[] = [
  brief({
    conversationId: "01J00000000000000000000021",
    title: "Weekly sales trend",
    userQuestion: "How did this week compare to last week?",
    answerExcerpt: "Sales were $18,400 this week, down 11% on last week. Wednesday was the weak day. Parts held up; bikes slipped.",
    followUps: ["Which products dragged Wednesday?", "How did labour hours compare?"],
    keyInsights: [
      { value: "-11%", label: "Week-on-week sales", sentiment: "negative" },
      { value: "Wednesday", label: "Weakest day" },
    ],
    claims: ["Wednesday takings were the lowest day"],
    updatedAt: "2026-08-21T04:00:00.000Z",
  }),
  brief({
    conversationId: "01J00000000000000000000033",
    title: "Margin by category",
    userQuestion: "Which categories are compressing margin?",
    answerExcerpt: "Parts margin sat at 31% against 44% for workshop. Accessories were steady.",
    keyInsights: [{ value: "31%", label: "Parts margin", sentiment: "negative" }],
    claims: ["Parts margin is 13 points below workshop"],
    updatedAt: "2026-08-15T02:00:00.000Z",
  }),
  brief({
    conversationId: "01J00000000000000000000031",
    title: "Top customers this month",
    userQuestion: "Who were the top customers this month?",
    answerExcerpt: "Two trade accounts made up 28% of month sales. Several high spenders have not returned in 90 days.",
    keyInsights: [{ value: "28%", label: "Trade concentration" }],
    claims: ["Several high spenders have not returned in 90 days"],
    updatedAt: "2026-08-18T03:00:00.000Z",
  }),
];

test("the homepage recommended analysis surface is a single briefing panel fed by the daily look", () => {
  const page = read("app/dash/page.tsx");
  const component = read("app/dash/components/RecommendedAnalysis.tsx");
  const css = read("app/dash/dash.module.css");
  const route = read("app/api/recommended-analysis/route.ts");
  const migration = read("infra/migrations/control-plane/0164_m8_recommended_analysis_corpus.sql");
  const adr = read("docs/adr/0117-recommended-analysis.md");
  const dailyAdr = read("docs/adr/0133-daily-look.md");
  const bridge = read("services/imessage-bridge/src/main.ts");
  const loop = read("services/imessage-bridge/src/daily-brief.ts");
  assert.match(page, /import RecommendedAnalysis from "\.\/components\/RecommendedAnalysis"/u);
  assert.match(page, /showRecommendedHome[\s\S]*<RecommendedAnalysis/u);
  // The daily look's standing conversation is bookkeeping, hidden from history like `Alerts ·`.
  assert.match(page, /conversation\.title\.startsWith\(DAILY_BRIEF_CONVERSATION_TITLE_PREFIX\)/u);
  assert.doesNotMatch(page, /showRecentHomeAnalyses|Recent analysis/u);
  assert.match(component, /What to look at next/u);
  // One sentence per row with the tool's logo at the left; no skeleton and no per-visit refinement.
  assert.match(component, /CONNECTOR_LOGOS\[item\.tool\]/u);
  assert.match(component, /if \(recommendations\.length === 0\) return null;/u);
  assert.doesNotMatch(component, /recommendedAnalysisSkeleton|method: "POST"|recommendedAnalysisCardWhy/u);
  // Bare rows: no heading, verdict, card or border around them.
  assert.doesNotMatch(component, /recommendedAnalysisPanel|recommendedAnalysisHeader|recommendedAnalysisTitle|recommendedAnalysisVerdict|<h3/u);
  // Below the composer and out of the flow, so the composer stays centred.
  assert.match(css, /\.recommendedAnalysis \{[^}]*position: absolute;[^}]*top: calc\(100% \+ \d+px\);/u);
  assert.match(route, /composePlaybookBrief/u);
  assert.match(route, /isDailyBriefModel/u);
  assert.match(route, /withRecommendedTools/u);
  assert.match(route, /loadProactiveSignal/u);
  assert.doesNotMatch(route, /export async function POST|synthesizeRecommendedAnalysis|OPENAI_API_KEY/u);
  assert.match(migration, /albert_recommended_analysis_corpus/u);
  assert.match(migration, /p_verdict/u);
  assert.match(adr, /Corpus, not last-four/u);
  assert.match(adr, /ADR 0133/u);
  assert.match(dailyAdr, /gpt-5\.6-luna/u);
  assert.match(bridge, /new DailyBriefLoop\(/u);
  assert.match(loop, /dailyBriefModelLabel\(this\.deps\.model\)/u);
});

test("playbook rows name the connected tool they read", () => {
  const now = new Date("2026-08-23T03:00:00.000Z");
  const rows = buildPlaybookRecommendations(bikeShopBriefs, ["lightspeed-r", "xero", "deputy"], now);
  assert.equal(rows.length, 3);
  for (const item of rows) assert.ok(item.tool === null || typeof item.tool === "string", item.question);
  const cash = rows.find((item) => item.domain === "cash");
  if (cash) assert.equal(cash.tool, "xero");
  const staff = rows.find((item) => item.domain === "staff");
  if (staff) assert.equal(staff.tool, "deputy");
  const posOnly = buildPlaybookRecommendations(bikeShopBriefs, ["lightspeed-r"], now);
  assert.ok(posOnly.every((item) => item.tool === "lightspeed"), "with only a till connected every row reads Lightspeed");
});

test("elliptical follow-ups become self-contained questions", () => {
  const source = bikeShopBriefs[0];
  assert.equal(
    makeSelfContained("Break this down by store", source),
    "Break week-on-week sales down by store?",
  );
  assert.equal(
    makeSelfContained("Which products dragged Wednesday?", source),
    "Which products dragged Wednesday?",
  );
});

test("the playbook prefers coverage gaps over another recap of the last chat", () => {
  const now = new Date("2026-08-23T03:00:00.000Z");
  const recommendations = buildPlaybookRecommendations(
    bikeShopBriefs,
    ["lightspeed-r", "xero", "deputy"],
    now,
  );
  assert.equal(recommendations.length, 3);
  const questions = recommendations.map((item) => item.question.toLowerCase());
  const asked = collectAskedQuestions(bikeShopBriefs);
  for (const item of recommendations) {
    assert.match(item.question, /\?$/u);
    assert.ok(!asked.has(normalizeQuestion(item.question)), item.question);
    assert.ok(!/\bhow did this week compare to last week\b/iu.test(item.question));
    assert.ok(item.why.length >= 8);
  }
  assert.ok(
    questions.some((question) => question.includes("wednesday") || question.includes("labour") || question.includes("bank")),
    "unused follow-ups or a close-the-loop should surface",
  );
  assert.ok(
    questions.some((question) => question.includes("parts") && question.includes("margin"))
      || questions.some((question) => question.includes("bank") || question.includes("labour")),
    "a named gap or a missing connected surface should become a next question",
  );
  assert.ok(
    questions.some((question) => question.includes("bank") || question.includes("labour")),
    "sales without cash or labour should close the loop",
  );
  assert.ok(
    new Set(recommendations.map((item) => item.domain)).size >= 2,
    "recommendations should cover more than one domain",
  );
});

test("close-the-loop prompts respect connected tools", () => {
  const now = new Date("2026-08-23T03:00:00.000Z");
  const posOnly = buildPlaybookRecommendations(bikeShopBriefs, ["lightspeed-r"], now);
  assert.equal(connectorHints(["lightspeed-r", "xero", "deputy"]).xero, true);
  assert.ok(!posOnly.some((item) => item.question.toLowerCase().includes("bank")));
  assert.ok(!posOnly.some((item) => /\blabour cost\b/iu.test(item.question)));
});

test("a longer coverage index finds surfaces the last chats never asked", () => {
  const now = new Date("2026-08-23T03:00:00.000Z");
  const coverage: readonly CoverageThread[] = [
    {
      conversationId: "01J00000000000000000000021",
      title: "Weekly sales trend",
      updatedAt: "2026-08-21T04:00:00.000Z",
      question: "How did this week compare to last week?",
    },
    {
      conversationId: "01J00000000000000000000041",
      title: "Saturday vs Sunday",
      updatedAt: "2026-07-12T04:00:00.000Z",
      question: "How did Saturday compare with Sunday last month?",
    },
  ];
  const recommendations = buildPlaybookRecommendations(
    [bikeShopBriefs[0]!],
    ["lightspeed-r", "xero", "deputy"],
    now,
    { coverage },
  );
  const questions = recommendations.map((item) => item.question.toLowerCase());
  assert.ok(
    questions.some((question) => question.includes("bank") || question.includes("labour") || question.includes("90 days")),
    "cash, labour or stock should appear when the history is sales-only",
  );
});

test("the playbook verdict names what has gone quiet", () => {
  const corpus = buildAnalysisCorpus({
    briefs: bikeShopBriefs,
    connectors: ["lightspeed-r", "xero", "deputy"],
  });
  const verdict = buildPlaybookVerdict(corpus, new Date("2026-08-23T03:00:00.000Z"));
  assert.match(verdict, /cash|labour|stock/iu);
  assert.doesNotMatch(verdict, /last 4 conversations/iu);
});

test("playbook stays empty when there is no prior analysis", () => {
  assert.deepEqual(buildPlaybookRecommendations([], ["xero"]), []);
});
