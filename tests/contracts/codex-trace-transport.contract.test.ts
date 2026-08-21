import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexTraceTransportState,
  projectCodexRuntimeEvent,
} from "../../packages/albert-codex/src/trace-transport.ts";
import type { CodexTraceEventInput } from "../../packages/albert-codex/src/semantic-runtime.ts";
import {
  assertOrderedSanitizedTrace,
  type TraceEvent,
} from "../../packages/shared/src/agent-runtime.ts";

const provenance = {
  sources: [{ connector: "lightspeed" as const, label: "Fixture Cube", dataThrough: "2026-08-20" }],
  timeRange: { label: "Fixture period", start: "2026-08-01", end: "2026-08-20", timezone: "Australia/Melbourne" },
  definitions: [],
  semanticBundleHash: "fixture",
  identityGraph: { version: 0, hash: "fixture" },
};

test("an answer survives a complex native plan that left tasks open after ten valid tables", () => {
  let state = createCodexTraceTransportState();
  const projected: CodexTraceEventInput[] = [];
  const accept = (event: CodexTraceEventInput) => {
    const next = projectCodexRuntimeEvent(state, event);
    state = next.state;
    projected.push(...next.events);
  };
  const resultIds = Array.from({ length: 10 }, (_, index) => `result_${index + 1}`);
  resultIds.forEach((resultId, index) => accept({
    type: "table",
    status: "complete",
    caption: `Fixture result ${index + 1}`,
    columns: [{ key: "value", label: "Value", type: "number" }],
    rows: [{ value: index + 1 }],
    resultId,
    provenance,
    presentation: "evidence",
  }));
  accept({
    type: "plan",
    status: "complete",
    steps: [
      { id: "codex_plan_step_1", label: "Check sales", status: "active", kind: "evidence", evidenceResultIds: resultIds },
      { id: "codex_plan_step_2", label: "Assess customers", status: "pending", kind: "evidence", evidenceResultIds: [] },
      { id: "codex_plan_step_3", label: "Review inventory", status: "pending", kind: "evidence", evidenceResultIds: [] },
      { id: "codex_plan_step_4", label: "Assess cash", status: "pending", kind: "evidence", evidenceResultIds: [] },
      { id: "codex_plan_step_5", label: "Synthesize", status: "pending", kind: "synthesis", evidenceResultIds: [] },
    ],
  });
  accept({
    type: "answer",
    status: "complete",
    state: "Qualified",
    text: "The fixture health check is qualified.",
    provenance,
    followUps: [],
    presentedResultIds: resultIds.slice(0, 4),
    claims: [],
  });

  const terminalPlan = projected.at(-2);
  assert.equal(terminalPlan?.type, "plan");
  if (terminalPlan?.type !== "plan") throw new Error("Missing terminal plan.");
  assert.equal(terminalPlan.steps.some((step) => step.status === "active" || step.status === "pending"), false);
  assert.equal(projected.at(-1)?.type, "answer");

  const trace = projected.map((event, index) => ({
    ...event,
    id: `trace_${index + 1}`,
    sequence: index + 1,
    occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
  })) as TraceEvent[];
  assert.equal(assertOrderedSanitizedTrace(trace).length, trace.length);
});
