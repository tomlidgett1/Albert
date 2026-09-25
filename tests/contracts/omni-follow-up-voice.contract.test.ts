import assert from "node:assert/strict";
import test from "node:test";
import { extractOmniFollowUps, ownerVoiceFollowUp } from "../../packages/albert-omni/src/follow-ups.js";

// A suggested follow-up is sent as the owner's own message when they tap it.
// Production follow-ups from ten days of Omni turns were written as Albert's
// offers or as questions to the owner, which read backwards once sent: the
// owner tapped "Would you like the last sale date for each Trace model?".

test("an offer becomes the request it offers", () => {
  for (const [offered, request] of [
    ["Would you like the last sale date for each Trace model?", "Show the last sale date for each Trace model"],
    ["Want me to break the change down by product category?", "Break the change down by product category"],
    ["Should I compare these weeks by sales channel?", "Compare these weeks by sales channel"],
    ["Want the top five sales from yesterday?", "Show the top five sales from yesterday"],
    ["Want this compared with the prior 12 months?", "Show this compared with the prior 12 months"],
    ["Want to see which days or products drove the drop?", "Show which days or products drove the drop"],
    ["Want March's operating-expense spike broken down by account?", "Show March's operating-expense spike broken down by account"],
    ["Do you want to know which staff sold the most?", "Show which staff sold the most"],
    ["Would you like me to show you the weekly trend?", "Show me the weekly trend"],
  ] as const) assert.equal(ownerVoiceFollowUp(offered), request, offered);
  // An instruction the owner could send keeps its own punctuation.
  assert.equal(ownerVoiceFollowUp("Compare with last year?"), "Compare with last year?");
});

test("a question to the owner becomes the owner's question, about the business as we and our", () => {
  for (const [asked, owners] of [
    ["Should you pause new workshop intake while clearing the backlog?", "Should we pause new workshop intake while clearing the backlog?"],
    ["Are your workshop promise dates realistic with current staffing?", "Are our workshop promise dates realistic with current staffing?"],
    ["Are road bike prices locked in, or can you adjust them?", "Are road bike prices locked in, or can we adjust them?"],
    ["Check if that name appears in your customer list", "Check if that name appears in our customer list"],
  ] as const) assert.equal(ownerVoiceFollowUp(asked), owners, asked);
});

test("a request in the owner's voice is left alone, and filler is dropped", () => {
  for (const kept of ["Why did August takings fall?", "Which Trace models sold best this year?", "Draft a negotiating reply to the supplier", "How does this compare to last year by week?"]) {
    assert.equal(ownerVoiceFollowUp(kept), kept);
  }
  assert.equal(ownerVoiceFollowUp("[How does this compare to last year by week?](?ai-query=How%20does%20this%20compare)"), "How does this compare to last year by week?");
  assert.equal(ownerVoiceFollowUp("Is there anything else you'd like to know?"), null);
  assert.equal(ownerVoiceFollowUp("Let me know if you want more detail."), null);
});

test("follow-up links in an answer body come out in the owner's voice", () => {
  const extracted = extractOmniFollowUps([
    "Revenue was $12,400 this week.",
    "",
    "[Want me to split this by store?](?ai-query=Want%20me%20to%20split%20this%20by%20store%3F)",
    "[Which products drove the rise?](?ai-query=Which%20products%20drove%20the%20rise%3F)",
  ].join("\n"));
  assert.deepEqual(extracted.followUps, ["Split this by store", "Which products drove the rise?"]);
});
