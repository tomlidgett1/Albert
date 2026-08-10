import assert from "node:assert/strict";
import test from "node:test";

import { responseVisibleResultIds } from "../../app/dash/lib/answer-presentation.js";
import type { TraceEvent, TraceProvenance, TraceTableEvent } from "../../packages/shared/src/index.js";

const provenance: TraceProvenance = {
  sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-08-09T00:00:00.000Z" }],
  timeRange: {
    label: "All available history",
    start: "2020-01-01T00:00:00.000Z",
    end: "2026-08-09T00:00:00.000Z",
    timezone: "Australia/Melbourne",
  },
  definitions: [],
  semanticBundleHash: "presentation-test",
  identityGraph: { version: 0, hash: "0".repeat(32) },
};

function table(sequence: number, resultId: string): TraceTableEvent {
  return {
    id: `event_${sequence}`,
    sequence,
    type: "table",
    status: "complete",
    occurredAt: `2026-08-09T00:00:0${sequence}.000Z`,
    caption: `Internal result ${sequence}`,
    columns: [
      { key: "label", label: "Label", type: "string" },
      { key: "value", label: "Value", type: "number" },
    ],
    rows: [{ label: resultId, value: sequence }],
    resultId,
    provenance,
  };
}

test("the response model suppresses three internal tables unless the analyst or a chart selected them", () => {
  const events: TraceEvent[] = [
    table(1, "diagnostic_population"),
    table(2, "chart_source"),
    {
      id: "event_3",
      sequence: 3,
      type: "chart",
      status: "complete",
      occurredAt: "2026-08-09T00:00:03.000Z",
      caption: "Completed versus open",
      chartType: "bar",
      dataRef: "chart_source",
      xKey: "label",
      yKey: "value",
    },
    table(4, "intermediate_reconciliation"),
    {
      id: "event_5",
      sequence: 5,
      type: "answer",
      status: "complete",
      occurredAt: "2026-08-09T00:00:05.000Z",
      state: "Verified",
      text: "One direct explanation.",
      provenance,
      followUps: [],
      presentedResultIds: ["diagnostic_population"],
    },
  ];

  const visible = responseVisibleResultIds(events);
  assert.ok(visible);
  assert.deepEqual([...visible], ["diagnostic_population", "chart_source"]);
  assert.equal(visible.has("intermediate_reconciliation"), false);
});

test("an explicit empty presentation hides every uncharted table", () => {
  const events: TraceEvent[] = [
    table(1, "population_probe"),
    table(2, "state_probe"),
    table(3, "line_probe"),
    {
      id: "event_4",
      sequence: 4,
      type: "answer",
      status: "complete",
      occurredAt: "2026-08-09T00:00:04.000Z",
      state: "Qualified",
      text: "The answer uses the evidence without dumping it.",
      provenance,
      followUps: [],
      presentedResultIds: [],
    },
  ];

  const visible = responseVisibleResultIds(events);
  assert.ok(visible);
  assert.deepEqual([...visible], []);
});
