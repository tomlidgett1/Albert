/**
 * Social turns ("thanks", "hi", "ok bye") never reach the planner: the
 * deterministic detector answers them before the catalogue fetch and the
 * classifier, and the classifier has its own `social` lane for the rest.
 * Deterministic — no model, no Cube.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { detectSocialMessage, inferSocialKind, socialReply } from "../../packages/albert-v3/src/engine/social.js";
import { LANES, classifierInstructions, guardOrphanRefinement } from "../../packages/albert-v3/src/engine/orchestrator.js";
import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.js";

test("plain thanks, greetings, acknowledgements and sign-offs are detected without a model", () => {
  assert.equal(detectSocialMessage("Thanks"), "thanks");
  assert.equal(detectSocialMessage("thanks!"), "thanks");
  assert.equal(detectSocialMessage("Thank you so much, Albert 🙏"), "thanks");
  assert.equal(detectSocialMessage("cheers mate"), "thanks");
  assert.equal(detectSocialMessage("Great, thanks — that's all I needed."), "thanks");
  assert.equal(detectSocialMessage("hi"), "greeting");
  assert.equal(detectSocialMessage("Good morning Albert"), "greeting");
  assert.equal(detectSocialMessage("ok"), "acknowledgement");
  assert.equal(detectSocialMessage("Perfect."), "acknowledgement");
  assert.equal(detectSocialMessage("no worries"), "acknowledgement");
  assert.equal(detectSocialMessage("that's all for now"), "acknowledgement");
  assert.equal(detectSocialMessage("bye"), "farewell");
  assert.equal(detectSocialMessage("ok bye, see you tomorrow"), "farewell");
});

test("a message that thanks AND asks is not social", () => {
  assert.equal(detectSocialMessage("Thanks, now show me sales by store"), null);
  assert.equal(detectSocialMessage("great — what about last year?"), null);
  assert.equal(detectSocialMessage("thanks. how many customers do we have?"), null);
  assert.equal(detectSocialMessage("Sales yesterday"), null);
  assert.equal(detectSocialMessage("hi, what were takings last week"), null);
  assert.equal(detectSocialMessage("i need help with GST"), null);
});

test("bare agreement after Albert asked something is an answer, not chit-chat", () => {
  const asked = [
    { role: "user" as const, text: "sales" },
    { role: "assistant" as const, text: "Do you mean gross takings or net of GST?" },
  ];
  assert.equal(detectSocialMessage("ok", asked), null);
  assert.equal(detectSocialMessage("yes", asked), null);
  assert.equal(detectSocialMessage("yes"), null);
  assert.equal(detectSocialMessage("no"), null);
  assert.equal(detectSocialMessage("sure"), null);
  // Thanks after a question is still thanks.
  assert.equal(detectSocialMessage("thanks", asked), "thanks");
});

test("replies are short, run no queries and only greetings offer starter follow-ups", () => {
  const thanks = socialReply("thanks", "thanks");
  assert.match(thanks.text, /welcome/iu);
  assert.deepEqual(thanks.followUps, []);
  const greeting = socialReply("greeting", "good morning");
  assert.match(greeting.text, /^Good morning\./u);
  assert.ok(greeting.followUps.length >= 2);
  assert.equal(inferSocialKind("much obliged, cheers"), "thanks");
  assert.equal(inferSocialKind("catch you later"), "farewell");
  assert.equal(inferSocialKind("wonderful"), "acknowledgement");
});

test("the classifier has a social lane and it is not treated as an orphan refinement", () => {
  assert.ok(LANES.includes("social"));
  const instructions = classifierInstructions(loadAgentConfig(), [], ["lightspeed-r"]);
  assert.match(instructions, /- social: a greeting, thanks, acknowledgement or sign-off/u);
  const decision = {
    lane: "social" as const,
    resolvedQuestion: "Thanks for that chart",
    ownerGoal: null,
    answerShape: "fact" as const,
    answerMustCover: [],
    assumptions: [],
    clarificationQuestion: null,
    clarificationOptions: [],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
  };
  assert.equal(guardOrphanRefinement(decision, [], "Thanks for that chart").lane, "social");
});
