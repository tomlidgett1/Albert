import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildAnswerToolOutput,
  buildClarificationToolOutput,
  buildErrorToolOutput,
  createNarrationTracker,
  currencyToSpokenWords,
  describeTableEventForVoice,
  describeTraceEventForVoice,
  numberToSpokenWords,
  spellOutNumbersForSpeech,
  stripMarkdownForSpeech,
} from "../../app/dash/lib/voice-narration.ts";
import type {
  TraceAnswerEvent,
  TraceClarificationEvent,
  TraceEvent,
  TraceTableEvent,
} from "../../packages/shared/src/agent-runtime.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const base = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", sequence: 1, occurredAt: "2026-08-22T00:00:00.000Z" } as const;

test("voice narration speaks owner copy for progress, narrative and query events", () => {
  const progress: TraceEvent = {
    ...base,
    type: "progress",
    label: "Codex is planning the analysis",
    detail: "Using Albert's governed semantic catalogue",
  };
  assert.equal(describeTraceEventForVoice(progress), "planning the analysis");

  const narrative: TraceEvent = {
    ...base,
    type: "narrative",
    purpose: "acknowledgement",
    text: "Looking at today's sales now.",
  };
  assert.equal(describeTraceEventForVoice(narrative), "Looking at today's sales now.");

  const query: TraceEvent = {
    ...base,
    type: "query",
    topic: "sales_analytics",
    metrics: [],
    dimensions: [],
    timeRange: { start: "2026-08-22", end: "2026-08-22", label: "today" } as never,
    lens: "sales",
  };
  assert.equal(describeTraceEventForVoice(query), "looking up sales analytics");
});

test("voice narration stays silent on technical detail and visual events", () => {
  const technical: TraceEvent = {
    ...base,
    type: "progress",
    label: "Running SQL with governed claims",
    detail: "sales_analytics.gross_takings, sales_analytics.net_sales",
  };
  // Softened label survives; the member list never reaches speech.
  assert.equal(describeTraceEventForVoice(technical), "looking up your numbers");

  const narrativeWithSql: TraceEvent = {
    ...base,
    type: "narrative",
    text: "Validated the governed SQL against tenant staging.",
  };
  assert.equal(describeTraceEventForVoice(narrativeWithSql), null);

  // Machinery talk becomes plain owner language or silence — never speech
  // like "Albert checked the draft, codex is repairing it".
  const repairNarrative: TraceEvent = {
    ...base,
    type: "narrative",
    text: "Albert checked the draft answer and Codex is repairing it.",
  };
  assert.equal(describeTraceEventForVoice(repairNarrative), "double-checking the numbers");
  const codexNarrative: TraceEvent = {
    ...base,
    type: "narrative",
    text: "Codex confirmed the totals with the runtime.",
  };
  assert.equal(describeTraceEventForVoice(codexNarrative), null);

  const plan: TraceEvent = { ...base, type: "plan", steps: [] };
  assert.equal(describeTraceEventForVoice(plan), null);

  const unrecoverable: TraceEvent = {
    ...base,
    type: "error",
    message: "boom",
    recoverable: false,
  };
  assert.equal(describeTraceEventForVoice(unrecoverable), null);
});

test("narration sounds human: substance speaks, filler waits, quiet gets a brief check-in", () => {
  const tracker = createNarrationTracker({
    minIntervalMs: 10_000,
    genericIntervalMs: 25_000,
    heartbeatMs: 45_000,
  });
  tracker.primeImmediate();
  tracker.note("Looking at today's sales now.");
  assert.deepEqual(tracker.take(1_000), { line: "Looking at today's sales now.", kind: "update" });

  // The same line again is not re-spoken.
  tracker.note("Looking at today's sales now.");
  assert.equal(tracker.take(2_000), null);

  // Generic stage labels wait far longer than substance…
  tracker.note("looking up your numbers");
  assert.equal(tracker.take(12_000), null);
  // …and are displaced the moment real substance arrives.
  tracker.note("looking up sales analytics");
  assert.deepEqual(tracker.take(12_500), { line: "looking up sales analytics", kind: "update" });

  // Once substance is pending, filler cannot displace it.
  tracker.note("first numbers are in — sales today. gross takings $4,120");
  tracker.note("planning the analysis");
  assert.deepEqual(
    tracker.take(24_000),
    { line: "first numbers are in — sales today. gross takings $4,120", kind: "update" },
  );

  // A long quiet stretch produces one brief check-in, not a re-announcement.
  assert.equal(tracker.take(50_000), null);
  assert.deepEqual(tracker.take(70_000), { line: "", kind: "heartbeat" });

  // A lone generic label eventually speaks after its long interval.
  tracker.note("looking up your numbers");
  assert.equal(tracker.take(80_000), null);
  assert.deepEqual(tracker.take(96_000), { line: "looking up your numbers", kind: "update" });
});

test("completed governed tables become a spoken first-look headline", () => {
  const table: TraceTableEvent = {
    ...base,
    type: "table",
    status: "complete",
    caption: "Sales by product today",
    columns: [
      { key: "product", label: "Product", type: "string" },
      { key: "gross", label: "Gross takings", type: "currency", currency: "AUD" },
      { key: "count", label: "Sales", type: "number" },
    ],
    rows: [
      { product: "Flat white", gross: 981.4, count: 96 },
      { product: "Long black", gross: 540, count: 61 },
    ],
    resultId: "res_1",
    provenance: { runtime: "codex" } as never,
  };
  assert.equal(
    describeTableEventForVoice(table),
    "first numbers are in — sales by product today. Flat white: gross takings nine hundred and eighty-one dollars, sales ninety-six (top of two rows)",
  );

  // Incomplete tables, empty tables and technical captions stay silent.
  assert.equal(describeTableEventForVoice({ ...table, status: "running" }), null);
  assert.equal(describeTableEventForVoice({ ...table, rows: [] }), null);
  assert.equal(
    describeTableEventForVoice({ ...table, caption: "sales_analytics.gross_takings by tenant" }),
    null,
  );
});

test("voice turns run the fast codex profile instead of the selector depth", () => {
  const page = read("app/dash/page.tsx");
  const voiceRun = page.slice(page.indexOf("useVoiceSession({"), page.indexOf("useVoiceSession({") + 1_200);
  assert.match(voiceRun, /forceRuntime: "codex"/u);
  assert.match(voiceRun, /reasoningEffort: "low"/u);
  assert.match(voiceRun, /fastMode: true/u);
  // A non-codex model in the selector must not break spoken questions.
  assert.match(voiceRun, /gpt-5\.6-luna/u);
});

test("figures are spelled out in words so the voice cannot read digits one by one", () => {
  assert.equal(numberToSpokenWords(130), "one hundred and thirty");
  assert.equal(numberToSpokenWords(1_030), "one thousand and thirty");
  assert.equal(numberToSpokenWords(4_120), "four thousand, one hundred and twenty");
  assert.equal(numberToSpokenWords(0), "zero");
  assert.equal(numberToSpokenWords(12.4), "twelve point four");
  assert.equal(numberToSpokenWords(-96), "minus ninety-six");
  assert.equal(numberToSpokenWords(2_500_000), "two million, five hundred thousand");

  assert.equal(currencyToSpokenWords(4_120), "four thousand, one hundred and twenty dollars");
  assert.equal(currencyToSpokenWords(9.5), "nine dollars and fifty cents");
  assert.equal(currencyToSpokenWords(1, "AUD"), "one dollar");
  assert.equal(currencyToSpokenWords(250, "GBP"), "two hundred and fifty pounds");

  assert.equal(
    spellOutNumbersForSpeech("Revenue rose 12.4% to $1.2 million, with 1,243 sales."),
    "Revenue rose twelve point four percent to one point two million dollars, with one thousand, two hundred and forty-three sales.",
  );
  // Bare decimals and plain large integers convert too — "0.00" must never
  // become "zero zero point zero zero".
  assert.equal(
    spellOutNumbersForSpeech("Margin was 0.00 and takings were 130."),
    "Margin was zero and takings were one hundred and thirty.",
  );
  // Years, times and small counts are left alone — mangling a date is worse
  // than the original problem.
  assert.equal(
    spellOutNumbersForSpeech("Since 22 August 2026, 96 sales before 9:30am."),
    "Since 22 August 2026, 96 sales before 9:30am.",
  );
});

test("spoken answers strip markdown structure and keep claims bounded", () => {
  const answer: TraceAnswerEvent = {
    ...base,
    type: "answer",
    state: "Verified",
    text: [
      "## Sales today",
      "",
      "You took **$4,120** across 96 sales.",
      "",
      "| Product | Sales |",
      "| --- | --- |",
      "| Flat white | $980 |",
      "",
      "See [the detail](https://example.com/report).",
    ].join("\n"),
    provenance: { runtime: "codex" } as never,
    followUps: ["Compare with last Friday", "Split by store", "Show margins", "Fourth"],
    claims: Array.from({ length: 9 }, (_, index) => ({
      statement: `Claim ${index + 1}`,
      assertion: "value" as const,
      refs: [],
    })),
  };
  const output = JSON.parse(buildAnswerToolOutput(answer)) as Record<string, unknown>;
  assert.equal(output.state, "Verified");
  // A verified answer carries no ceremony — and never "governed evidence".
  assert.equal("note" in output, false);
  assert.ok(!buildAnswerToolOutput(answer).includes("governed"));
  const spoken = String(output.answer);
  assert.ok(!spoken.includes("|"), "tables must not be spoken");
  assert.ok(!spoken.includes("**"), "emphasis markers must not be spoken");
  assert.ok(!spoken.includes("##"), "headings must not be spoken");
  assert.ok(spoken.includes("The full table is on screen."));
  assert.ok(spoken.includes("See the detail."), "link text survives without the URL");
  assert.ok(
    spoken.includes("four thousand, one hundred and twenty dollars"),
    "money is spelled out in words for the voice",
  );
  assert.equal((output.key_findings as unknown[]).length, 6);
  assert.equal((output.follow_ups as unknown[]).length, 3);
});

test("clarifications and failures instruct the voice how to continue", () => {
  const clarification: TraceClarificationEvent = {
    ...base,
    type: "clarification",
    question: "Which store did you mean?",
    options: [
      { id: "a", label: "Ashburton" },
      { id: "b", label: "Bentleigh" },
    ],
  };
  const clarify = JSON.parse(buildClarificationToolOutput(clarification)) as Record<string, unknown>;
  assert.equal(clarify.state, "Clarification");
  assert.deepEqual(clarify.options, ["Ashburton", "Bentleigh"]);
  assert.match(String(clarify.instruction), /call ask_albert again/u);

  const failed = JSON.parse(buildErrorToolOutput("The analysis was stopped.")) as Record<string, unknown>;
  assert.equal(failed.state, "Failed");
});

test("stripMarkdownForSpeech drops code fences and list markers", () => {
  const spoken = stripMarkdownForSpeech([
    "Here is what I found:",
    "```sql",
    "SELECT 1",
    "```",
    "- First point",
    "* Second point",
  ].join("\n"));
  assert.ok(!spoken.includes("SELECT"));
  assert.ok(!spoken.includes("```"));
  assert.ok(spoken.includes("First point"));
  assert.ok(!/^[-*]\s/mu.test(spoken));
});

test("the voice session is minted server-side with the governed ask_albert contract", () => {
  const route = read("app/api/voice-session/route.ts");
  // The browser must never hold the real API key or author the session config.
  assert.match(route, /assertSameOriginMutation/u);
  assert.match(route, /requireUser\(\)/u);
  assert.match(route, /consumeAlbertRateLimit\("conversation\.voice_session"\)/u);
  assert.match(route, /realtime\/client_secrets/u);
  assert.match(route, /name: "ask_albert"/u);
  assert.match(route, /never invent or estimate figures/iu);
  // Perceived latency: the model must confirm aloud before the analysis runs,
  // and early partial numbers are provisional until the final result.
  assert.match(route, /The user must hear you immediately/u);
  assert.match(route, /the final result wins/u);
  // Human, not status bot: the persona bans filler and re-announcements.
  assert.match(route, /not a status bot/u);
  assert.match(route, /hang tight/u);
  // And bans machinery vocabulary outright.
  assert.match(route, /Never mention Albert's internal machinery/u);
  // The SDP exchange is proxied server-side: the page CSP keeps
  // connect-src 'self' and the ephemeral realtime key never reaches the
  // browser.
  assert.match(route, /realtime\/calls/u);
  assert.doesNotMatch(route, /clientSecret/u);
  // Realtime is global-routed for this org (the AU endpoint refuses
  // /realtime/calls); the route must not silently inherit OPENAI_BASE_URL.
  assert.match(route, /https:\/\/api\.openai\.com\/v1/u);
  assert.doesNotMatch(route, /process\.env\.OPENAI_BASE_URL/u);

  const repository = read("services/control-plane/src/web-repository.ts");
  assert.match(repository, /"conversation\.voice_session": Object\.freeze/u);
});
