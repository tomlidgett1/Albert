import assert from "node:assert/strict";
import test from "node:test";
import { recordDeletionProcessOutcome } from "./main.js";

test("retry outcomes preserve the prior completion and expose only the sanitized failure code", () => {
  const outcome = recordDeletionProcessOutcome(
    { lastCompletionAt: "2026-08-04T01:00:00.000Z", lastErrorCode: null },
    {
      status: "retry_scheduled",
      failure: {
        code: "database_unavailable",
        errorClass: "database",
        correlationId: "01K1VC6K4R4T0J4R9FQ2TY3ZZZ",
        retryable: true,
        failedAt: "2026-08-04T01:01:00.000Z",
      },
      retryDelaySeconds: 10,
    },
    "2026-08-04T01:01:01.000Z",
  );

  assert.deepEqual(outcome, {
    lastCompletionAt: "2026-08-04T01:00:00.000Z",
    lastErrorCode: "database_unavailable",
  });
});

test("completed outcomes advance completion time and clear a prior retry error", () => {
  const outcome = recordDeletionProcessOutcome(
    { lastCompletionAt: null, lastErrorCode: "database_unavailable" },
    { status: "completed" },
    "2026-08-04T01:02:00.000Z",
  );

  assert.deepEqual(outcome, {
    lastCompletionAt: "2026-08-04T01:02:00.000Z",
    lastErrorCode: null,
  });
});
