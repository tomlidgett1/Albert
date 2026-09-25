# 0152 — A turn that ran out of time still answers from what it checked

Date: 2026-09-24. Status: implemented.

## What happened

Yellow Jersey's Analytics tab, 08:00 to 08:12 UTC, GPT 6 Luna at Max, Fast:
"go deep on each category, tell me which products do best, which should
increase in retail price, and which are OOS that need to be re ordered." The
turn ran 35 queries over twelve minutes, each model step taking 30 to 76
seconds at Max. The owner saw only "The analysis ran out of time before
finishing." Every result was discarded.

## Why it happened

The 720-second turn already reserved its last 120 seconds for the answer
(commit 232d0f9): new queries stop, and a nudge asks the model to compose.
Three things defeated it:

1. **The nudge ran at the owner's effort with no deadline of its own.** At
   Max, writing an answer over 35 results took GPT 6 Luna longer than the
   whole reserve.
2. **The SDK ends an aborted streamed run quietly.** `@openai/agents` closes
   the stream on abort (`StreamedRunResult#handleAbort`) instead of throwing,
   so the exploring run returned empty at the cut. The "Writing the answer
   from the checks completed so far" step was never shown, and the unit test
   that throws on abort did not model it.
3. **Nothing caught the hard deadline.** A nudge still running at 720 seconds
   ended the turn with an error, however much evidence it held.

## Decision

**A turn with checked results always delivers them; the hard deadline is a
backstop, not a way to lose work.**

- The write-up has its own deadline, 15 seconds before the hard one (an
  eighth of shorter budgets). Out of exploration time it runs at **low
  effort** (`OmniDriverRunOptions.effort`; the SDK driver clones the agent
  with the same tools and prompt-cache key at that effort).
- If it still has not produced an accepted answer, the runtime composes one
  from the evidence (`composeCheckedResultsAnswer`): up to three of the
  newest results holding figures, as governed tables through `composeAnswer`
  (every cell bound to its result, identifier columns and earlier turns'
  results left out, headings from the query names with any figure removed),
  under one line saying the analysis ran out of time, a limitation that the
  interpretation and recommendations were not written, and the follow-up
  "Finish this analysis from the results we checked". Its state is Qualified.
  On iMessage, which has no tables, it says so in a line.
- A failed write-up (its deadline, a provider error) falls through to that
  answer. A turn the owner cancelled stays cancelled, and a turn with no
  checked results still fails honestly.
- The progress step "Writing the answer from the checks completed so far" is
  emitted whenever exploration ran out, whichever way the run ended.

## Evidence

`services/codex-runtime/omni-agent-loop.test.ts` reproduces the incident with
the SDK's quiet abort: exploration and the write-up both still thinking at
their deadlines. It failed with "The analysis timed out before finishing."
before this change and now delivers the checked table before the deadline,
with the write-up at low effort. `omni-answer-style.contract.test.ts` pins the
fallback's shape. `test:omni` 179 of 179; `test:contracts` 1755 of 1758, the
one failure being the known pre-existing runtime-comparison test.

## Consequences

- A slow model at Max can still run out of exploration time on a broad
  question; the owner now gets the checked results and a one-tap follow-up
  that finishes from them, instead of an error.
- The managed OAI Codex harness keeps its own deadline and synthesis step and
  is unchanged.
