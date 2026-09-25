import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { latestReasoningSummary } from "../../app/dash/lib/reasoning-summary.ts";
import { gatedCodexReasoningSummary } from "../../packages/albert-codex/src/semantic-runtime.ts";
import type { TraceEvent } from "../../packages/shared/src/agent-runtime.ts";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("reasoning-summary gate keeps public approach prose and rejects internal or ungrounded detail", () => {
  assert.equal(
    gatedCodexReasoningSummary(
      "I am comparing the strongest explanations, then checking whether the available evidence supports a clear conclusion.",
      [],
    ),
    "I am comparing the strongest explanations, then checking whether the available evidence supports a clear conclusion.",
  );
  assert.equal(
    gatedCodexReasoningSummary("The system prompt says to inspect the tool schema and resultId.", []),
    null,
  );
  assert.equal(
    gatedCodexReasoningSummary("Revenue appears to be 123 before I query the data.", []),
    null,
  );
  assert.equal(
    gatedCodexReasoningSummary("I will rerun the semantic query and report an update in commentary.", []),
    null,
  );
});

test("Detailed trail keeps only the latest reasoning-summary snapshot", () => {
  const occurredAt = "2026-08-24T00:00:00.000Z";
  const events: TraceEvent[] = [
    {
      id: "summary_1",
      sequence: 1,
      occurredAt,
      type: "narrative",
      purpose: "reasoning_summary",
      text: "I am checking the leading explanation.",
    },
    {
      id: "summary_2",
      sequence: 2,
      occurredAt,
      type: "narrative",
      purpose: "reasoning_summary",
      text: "I am checking the leading explanation and comparing the strongest alternative.",
    },
    {
      id: "commentary_1",
      sequence: 3,
      occurredAt,
      type: "narrative",
      text: "The available evidence now supports the next check.",
    },
  ];
  assert.equal(
    latestReasoningSummary(events),
    "I am checking the leading explanation and comparing the strongest alternative.",
  );
});

test("Codex opts into summaries but never forwards raw reasoning deltas", async () => {
  const [appServer, runtime, shared, trace, page, dashStyles] = await Promise.all([
    read("packages/albert-codex/src/app-server.ts"),
    read("packages/albert-codex/src/semantic-runtime.ts"),
    read("packages/shared/src/agent-runtime.ts"),
    read("app/dash/components/InsightsStyleTrace.tsx"),
    read("app/dash/page.tsx"),
    read("app/dash/dash.module.css"),
  ]);
  assert.match(appServer, /summary: "detailed"/u);
  assert.match(runtime, /item\/reasoning\/summaryTextDelta/u);
  assert.match(runtime, /item\/reasoning\/summaryTextDone/u);
  assert.match(runtime, /params\.source === "responses_api"/u);
  assert.match(runtime, /typeof summary\.text === "string"/u);
  assert.match(runtime, /purpose: "reasoning_summary"/u);
  assert.doesNotMatch(runtime, /item\/reasoning\/textDelta/u);
  assert.match(shared, /"acknowledgement" \| "reasoning_summary"/u);
  assert.match(trace, /Reasoning summary/u);
  assert.match(
    trace,
    /event\.purpose === "reasoning_summary"[\s\S]{0,120}continue;[\s\S]{0,220}commentary\.push/u,
  );
  const compactTrail = trace.slice(
    trace.indexOf("function ThinkingTrail"),
    trace.indexOf("function DetailedTrail"),
  );
  const detailedTrail = trace.slice(trace.indexOf("function DetailedTrail"));
  assert.doesNotMatch(compactTrail, /reasoningSummary/u);
  assert.match(detailedTrail, /reasoningSummary/u);
  assert.match(page, />Reasoning</u);
  assert.match(page, /setReasoningPanelOpen/u);
  assert.match(page, /latestReasoningSummary\(message\.events \?\? \[\]\)/u);
  assert.match(page, /aria-live=\{turn\.streaming \? "polite" : undefined\}/u);
  assert.match(page, /Private chain-of-thought stays hidden/u);
  assert.match(dashStyles, /\.reasoningPanelBody/u);
  assert.match(dashStyles, /\.reasoningPanelStatusDotLive/u);
});
