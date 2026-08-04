import assert from "node:assert/strict";
import test from "node:test";
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";

import type { TraceEvent } from "../packages/shared/src/index.js";
import {
  createTraceEmitter,
  runLiveAlbertTurn,
} from "../services/conversation/src/live.js";
import {
  criticalPromptRouteContract,
  type PromptRouteContract,
} from "../services/conversation/src/prompt-routing.js";
import {
  seedGoldenQuestions,
  type GoldenQuestion,
} from "./golden/questions.js";

const criticalCaseIds = [
  "workforce-best",
  "workforce-overtime",
  "finance-profit",
  "honesty-footfall",
] as const;

type CriticalCaseId = typeof criticalCaseIds[number];

const criticalQuestions = new Map<CriticalCaseId, GoldenQuestion>(criticalCaseIds.map((caseId) => {
  const question = seedGoldenQuestions.find((candidate) => candidate.id === caseId);
  if (!question) throw new Error(`Missing seed question ${caseId}.`);
  return [caseId, question];
}));

type ScriptStep = Readonly<{
  responseId: string;
  output: Readonly<Record<string, unknown>>;
}>;

function toolStep(index: number, name: string, argumentsValue: Readonly<Record<string, unknown>>): ScriptStep {
  return Object.freeze({
    responseId: `route_response_${index}`,
    output: Object.freeze({
      type: "function_call",
      callId: `route_call_${index}`,
      name,
      arguments: JSON.stringify(argumentsValue),
      status: "completed",
    }),
  });
}

function finalStep(index: number, output: Readonly<Record<string, unknown>>): ScriptStep {
  return Object.freeze({
    responseId: `route_response_${index}`,
    output: Object.freeze({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }),
  });
}

function userPromptFrom(request: ModelRequest): string {
  if (typeof request.input === "string") return request.input;
  const prompts = request.input.flatMap((item) => {
    if (!("role" in item) || item.role !== "user" || !("content" in item)) return [];
    if (typeof item.content === "string") return [item.content];
    if (!Array.isArray(item.content)) return [];
    return item.content.flatMap((part) => part.type === "input_text" ? [part.text] : []);
  });
  const prompt = prompts.at(-1);
  if (!prompt) throw new Error("Prompt-sensitive model did not receive a user prompt.");
  return prompt;
}

function assertRouteInstruction(request: ModelRequest, contract: PromptRouteContract): void {
  const instructions = request.systemInstructions ?? "";
  const expectedRoute = contract.route === "clarification"
    ? "Route: Clarification"
    : contract.route === "directory"
      ? "Route: Directory"
      : "Route: Unavailable";
  if (!instructions.includes("Current-turn server route contract") || !instructions.includes(expectedRoute)) {
    throw new Error("Prompt-sensitive model did not receive the trusted route instruction.");
  }
  if (contract.route === "clarification") {
    if (!instructions.includes(contract.question)
      || contract.optionIds.some((optionId) => !instructions.includes(optionId))) {
      throw new Error("Prompt-sensitive model received a substituted clarification instruction.");
    }
  } else if (contract.route === "directory") {
    if (!instructions.includes(`Field: ${contract.field}`)) {
      throw new Error("Prompt-sensitive model received a substituted directory instruction.");
    }
  } else if (!instructions.includes(contract.reasonCode)
    || !instructions.includes(contract.missingObservation)
    || !instructions.includes(contract.unlock)) {
    throw new Error("Prompt-sensitive model received a substituted unavailable instruction.");
  }
}

class PromptSensitiveRouteModel implements Model {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;

  constructor(private readonly expectedQuestion: GoldenQuestion) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error("Albert's production loop must use the streaming Responses path.");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const prompt = userPromptFrom(request);
    if (prompt !== this.expectedQuestion.question) {
      throw new Error("Prompt-sensitive model observed a substituted user prompt.");
    }
    const contract = criticalPromptRouteContract(prompt);
    if (!contract || contract.caseId !== this.expectedQuestion.id) {
      throw new Error("Prompt-sensitive model could not derive the expected route from the actual user prompt.");
    }
    assertRouteInstruction(request, contract);

    const step = contract.route === "clarification"
      ? this.clarificationStep(contract)
      : finalStep(1, {
          state: "Unavailable",
          text: "The required observation is not available.",
          claims: [],
          followUps: [],
        });
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        output: [step.output],
      },
    } as StreamEvent;
  }

  private clarificationStep(contract: Extract<PromptRouteContract, { route: "clarification" }>): ScriptStep {
    const index = ++this.cursor;
    if (index === 1) {
      return toolStep(index, "ask_user", {
        question: contract.question,
        options: contract.optionIds.map((id) => ({ id })),
      });
    }
    if (index === 2) {
      return finalStep(index, {
        state: "Clarification",
        text: contract.question,
        claims: [],
        followUps: [],
      });
    }
    throw new Error("Prompt-sensitive clarification model received an unexpected extra request.");
  }
}

class FixedStepModel implements Model {
  private cursor = 0;

  constructor(private readonly steps: readonly ScriptStep[]) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error("Albert's production loop must use the streaming Responses path.");
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("Fixed-step model received an unexpected extra request.");
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        output: [step.output],
      },
    } as StreamEvent;
  }
}

function traceEmitter(events: TraceEvent[]) {
  return createTraceEmitter({
    persist: async (event) => { events.push(event); },
    deliver: () => undefined,
  });
}

function turnOptions(
  question: GoldenQuestion,
  model: Model,
  events: TraceEvent[],
) {
  return {
    message: question.question,
    preferences: { model: "gpt-5.6-sol" as const, reasoningEffort: "high" as const, fastMode: true },
    tenantId: "tenant_prompt_routing_eval",
    role: "owner" as const,
    conversationId: `conversation_${question.id}`,
    turnId: `turn_${question.id}`,
    modelContext: [{ role: "user" as const, text: question.question }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: `prompt_routing_${question.id}`,
    modelProvider: { getModel: () => model } satisfies ModelProvider,
    semanticClient: {
      async execute(): Promise<never> {
        throw new Error("A critical clarification or unavailable route attempted data access.");
      },
    },
    emit: traceEmitter(events),
  };
}

for (const caseId of criticalCaseIds) {
  test(`${caseId} executes the actual prompt-sensitive Agents SDK route`, async () => {
    const question = criticalQuestions.get(caseId);
    assert.ok(question);
    const contract = criticalPromptRouteContract(question.question);
    assert.ok(contract);
    const model = new PromptSensitiveRouteModel(question);
    const events: TraceEvent[] = [];

    const result = await runLiveAlbertTurn(turnOptions(question, model, events));

    assert.equal(result.answerState.toLocaleLowerCase("en-AU"), question.expectedState);
    assert.equal(model.requests.length, contract.route === "clarification" ? 2 : 1);
    assert.ok(model.requests.every((request) => userPromptFrom(request) === question.question));
    assert.equal(events.some((event) => event.type === "query" || event.type === "table" || event.type === "chart"), false);
    if (contract.route === "clarification") {
      assert.equal(events.some((event) => event.type === "answer"), false);
      const clarification = events.find((event) => event.type === "clarification");
      assert.ok(clarification?.type === "clarification");
      assert.equal(clarification.question, contract.question);
      assert.deepEqual(clarification.options.map(({ id }) => id), contract.optionIds);
    } else {
      assert.equal(events.some((event) => event.type === "clarification"), false);
      const answer = events.findLast((event) => event.type === "answer");
      assert.ok(answer?.type === "answer");
      assert.equal(answer.state, "Unavailable");
      assert.match(answer.text, /unavailable/u);
      assert.match(answer.text, /unlock/u);
      if (caseId === "workforce-overtime") assert.match(answer.text, /Deputy.+overtime duration/u);
      if (caseId === "honesty-footfall") assert.match(answer.text, /foot-traffic source.+governed visit metric/u);
    }
  });
}

test("a model that ignores the actual profit prompt cannot substitute the workforce clarification", async () => {
  const question = criticalQuestions.get("finance-profit");
  assert.ok(question);
  const workforce = criticalPromptRouteContract(criticalQuestions.get("workforce-best")?.question ?? "");
  assert.ok(workforce?.route === "clarification");
  const model = new FixedStepModel([
    toolStep(1, "ask_user", {
      question: workforce.question,
      options: workforce.optionIds.map((id) => ({ id })),
    }),
    finalStep(2, {
      state: "Clarification",
      text: workforce.question,
      claims: [],
      followUps: [],
    }),
  ]);

  await assert.rejects(
    runLiveAlbertTurn(turnOptions(question, model, [])),
    /ignored the server-owned clarification route contract/u,
  );
});

test("a prompt-sensitive eval fails when its configured user prompt is substituted", async () => {
  const expectedQuestion = criticalQuestions.get("workforce-best");
  const substitutedQuestion = criticalQuestions.get("finance-profit");
  assert.ok(expectedQuestion && substitutedQuestion);
  const model = new PromptSensitiveRouteModel(expectedQuestion);

  await assert.rejects(
    runLiveAlbertTurn(turnOptions(substitutedQuestion, model, [])),
    /substituted user prompt/u,
  );
});

test("a model cannot claim Clarification while ignoring the required ask_user action", async () => {
  const question = criticalQuestions.get("workforce-best");
  assert.ok(question);
  const model = new FixedStepModel([
    finalStep(1, {
      state: "Clarification",
      text: "Choose a performance lens.",
      claims: [],
      followUps: [],
    }),
  ]);

  await assert.rejects(
    runLiveAlbertTurn(turnOptions(question, model, [])),
    /ignored the server-owned clarification route contract/u,
  );
});
