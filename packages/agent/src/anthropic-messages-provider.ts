import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
  ToolChoice,
} from "@anthropic-ai/sdk/resources/messages";
import {
  Usage,
  type AgentInputItem,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import {
  ANTHROPIC_ADAPTIVE_DEFAULT_MAX_OUTPUT_TOKENS,
  CLAUDE_HAIKU_4_5_MODEL_ID,
  HAIKU_MAX_OUTPUT_TOKENS,
  HAIKU_THINKING_BUDGET_TOKENS,
  anthropicMaxOutputTokens,
  anthropicUsesAdaptiveThinking,
  isAlbertModelId,
  isAnthropicModel,
  isReasoningEffort,
  type ReasoningEffort,
  type ResolvedAlbertModelTransport,
} from "../../shared/src/index.js";

const ANTHROPIC_REPLAY_KEY = "albert_anthropic_message";
const ANTHROPIC_MAX_STRICT_TOOLS = 20;
const ANTHROPIC_SAFE_TEXT_ONLY_STRICT_TOOLS = 4;
const ANTHROPIC_MAX_OPTIONAL_PARAMETERS = 24;
const ANTHROPIC_MAX_UNION_PARAMETERS = 16;

type AnthropicMessagesClient = Readonly<{
  messages: Readonly<{
    stream: (
      body: MessageCreateParamsNonStreaming,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Readonly<{
      finalMessage: () => PromiseLike<Message>;
      request_id?: string | null;
    }>;
  }>;
}>;

type AnthropicReplayMarker = Readonly<{
  responseId: string;
  content: readonly ContentBlockParam[];
}>;

type SchemaComplexity = Readonly<{
  optionalParameters: number;
  unionParameters: number;
}>;

type AnthropicSchemaPolicy = Readonly<{
  optionalParameters: number;
  unionParameters: number;
  strictToolsRequested: number;
  strictToolsEnabled: number;
  strictToolsDowngraded: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaComplexity(schema: unknown): SchemaComplexity {
  let optionalParameters = 0;
  let unionParameters = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (Array.isArray(value.anyOf) || Array.isArray(value.type)) {
      unionParameters += 1;
    }
    if (isRecord(value.properties)) {
      const required = new Set(
        Array.isArray(value.required)
          ? value.required.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
      optionalParameters += Object.keys(value.properties)
        .filter((property) => !required.has(property))
        .length;
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
  return Object.freeze({ optionalParameters, unionParameters });
}

function isNullSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "null";
}

function withoutNullableUnion(value: unknown): Readonly<{
  nullable: boolean;
  schema: unknown;
}> {
  if (!isRecord(value)) return { nullable: false, schema: value };
  if (Array.isArray(value.anyOf) && value.anyOf.some(isNullSchema)) {
    const alternatives = value.anyOf.filter((candidate) => !isNullSchema(candidate));
    if (alternatives.length === 1 && isRecord(alternatives[0])) {
      return {
        nullable: true,
        schema: {
          ...alternatives[0],
          ...(typeof value.description === "string" ? { description: value.description } : {}),
        },
      };
    }
    return { nullable: true, schema: { ...value, anyOf: alternatives } };
  }
  if (Array.isArray(value.type) && value.type.includes("null")) {
    const types = value.type.filter((candidate) => candidate !== "null");
    return {
      nullable: true,
      schema: {
        ...value,
        type: types.length === 1 ? types[0] : types,
      },
    };
  }
  return { nullable: false, schema: value };
}

function simplifyNullableOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(simplifyNullableOutputSchema);
  if (!isRecord(value)) return value;
  const simplified: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, simplifyNullableOutputSchema(child)]),
  );
  if (!isRecord(value.properties)) return simplified;

  const required = new Set(
    Array.isArray(value.required)
      ? value.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const properties: Record<string, unknown> = {};
  for (const [name, propertySchema] of Object.entries(value.properties)) {
    const withoutNull = withoutNullableUnion(propertySchema);
    properties[name] = simplifyNullableOutputSchema(withoutNull.schema);
    if (withoutNull.nullable) required.delete(name);
  }
  simplified.properties = properties;
  simplified.required = [...required];
  return simplified;
}

function resolveLocalSchemaReference(schema: unknown, root: unknown): unknown {
  if (!isRecord(schema) || typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) {
    return schema;
  }
  let resolved: unknown = root;
  for (const encodedPart of schema.$ref.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(resolved)) return schema;
    resolved = resolved[part];
  }
  return resolved ?? schema;
}

function schemaAllowsNull(schema: unknown, root: unknown): boolean {
  const resolved = resolveLocalSchemaReference(schema, root);
  if (!isRecord(resolved)) return false;
  return resolved.type === "null"
    || (Array.isArray(resolved.type) && resolved.type.includes("null"))
    || (Array.isArray(resolved.anyOf) && resolved.anyOf.some((candidate) =>
      schemaAllowsNull(candidate, root),
    ));
}

function schemaForValue(schema: unknown, value: unknown, root: unknown): unknown {
  const resolved = resolveLocalSchemaReference(schema, root);
  if (!isRecord(resolved) || !Array.isArray(resolved.anyOf)) return resolved;
  const candidates = resolved.anyOf
    .map((candidate) => resolveLocalSchemaReference(candidate, root))
    .filter((candidate) => !isNullSchema(candidate));
  const matching = candidates.find((candidate) => {
    if (!isRecord(candidate)) return false;
    if (candidate.type === "object") return isRecord(value);
    if (candidate.type === "array") return Array.isArray(value);
    if (candidate.type === "string") return typeof value === "string";
    if (candidate.type === "number" || candidate.type === "integer") return typeof value === "number";
    if (candidate.type === "boolean") return typeof value === "boolean";
    return false;
  });
  return matching ?? candidates[0] ?? resolved;
}

function restoreRequiredNullableFields(value: unknown, schema: unknown, root = schema): unknown {
  if (value === null || value === undefined) return value;
  const resolved = schemaForValue(schema, value, root);
  if (!isRecord(resolved)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => restoreRequiredNullableFields(item, resolved.items, root));
  }
  if (!isRecord(value) || !isRecord(resolved.properties)) return value;

  const restored: Record<string, unknown> = { ...value };
  const required = new Set(
    Array.isArray(resolved.required)
      ? resolved.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  for (const [name, propertySchema] of Object.entries(resolved.properties)) {
    if (!(name in restored)) {
      if (required.has(name) && schemaAllowsNull(propertySchema, root)) restored[name] = null;
      continue;
    }
    restored[name] = restoreRequiredNullableFields(restored[name], propertySchema, root);
  }
  return restored;
}

function normalizeStructuredOutputText(text: string, restoreSchema: unknown): string {
  try {
    return JSON.stringify(restoreRequiredNullableFields(JSON.parse(text), restoreSchema));
  } catch {
    // The Agents SDK remains authoritative and will reject malformed JSON or
    // a value that does not satisfy Albert's original Zod schema.
    return text;
  }
}

function applyAnthropicSchemaBudget(
  tools: readonly Tool[],
  outputConfig: MessageCreateParamsNonStreaming["output_config"],
): Readonly<{ tools: Tool[]; policy: AnthropicSchemaPolicy }> {
  // Anthropic compiles JSON output plus every strict tool as one grammar. When
  // structured output is present, reserve that grammar entirely for the final
  // result. Text-only calls may retain up to four low-complexity strict tools.
  // A downgraded tool is less constrained only at sampling time: the Agents
  // SDK still validates its original Zod schema before Albert executes it, so
  // invalid input fails closed.
  const outputComplexity = schemaComplexity(outputConfig?.format?.schema);
  if (
    outputComplexity.unionParameters > ANTHROPIC_MAX_UNION_PARAMETERS
    || outputComplexity.optionalParameters > ANTHROPIC_MAX_OPTIONAL_PARAMETERS
  ) {
    throw new Error(
      "Claude output schema exceeds Anthropic's structured-output complexity limits.",
    );
  }

  const candidates = tools
    .map((tool, index) => ({
      index,
      requested: tool.strict === true,
      complexity: schemaComplexity(tool.input_schema),
    }))
    .filter(({ requested }) => requested)
    .sort((left, right) =>
      left.complexity.unionParameters - right.complexity.unionParameters
      || left.complexity.optionalParameters - right.complexity.optionalParameters
      || left.index - right.index,
    );
  const enabled = new Set<number>();
  let unionParameters = outputComplexity.unionParameters;
  let optionalParameters = outputComplexity.optionalParameters;
  const strictToolLimit = outputConfig
    ? 0
    : Math.min(ANTHROPIC_SAFE_TEXT_ONLY_STRICT_TOOLS, ANTHROPIC_MAX_STRICT_TOOLS);
  for (const candidate of candidates) {
    if (enabled.size >= strictToolLimit) break;
    const nextUnions = unionParameters + candidate.complexity.unionParameters;
    const nextOptional = optionalParameters + candidate.complexity.optionalParameters;
    if (
      nextUnions > ANTHROPIC_MAX_UNION_PARAMETERS
      || nextOptional > ANTHROPIC_MAX_OPTIONAL_PARAMETERS
    ) {
      continue;
    }
    enabled.add(candidate.index);
    unionParameters = nextUnions;
    optionalParameters = nextOptional;
  }

  const strictToolsRequested = candidates.length;
  const strictToolsEnabled = enabled.size;
  return Object.freeze({
    tools: tools.map((tool, index) =>
      tool.strict === true && !enabled.has(index)
        ? { ...tool, strict: false }
        : tool,
    ),
    policy: Object.freeze({
      optionalParameters,
      unionParameters,
      strictToolsRequested,
      strictToolsEnabled,
      strictToolsDowngraded: strictToolsRequested - strictToolsEnabled,
    }),
  });
}

/**
 * The Messages API rejects ill-formed Unicode (lone surrogates) anywhere in
 * the request. Model output and governed data both occasionally carry them,
 * so every string Albert puts on the wire is well-formed first.
 */
function wireText(value: string): string {
  return value.toWellFormed();
}

function replayableBlock(value: unknown): ContentBlockParam | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: wireText(value.text) };
  }
  if (
    value.type === "thinking"
    && typeof value.thinking === "string"
    && typeof value.signature === "string"
  ) {
    return {
      type: "thinking",
      thinking: value.thinking,
      signature: value.signature,
    };
  }
  if (value.type === "redacted_thinking" && typeof value.data === "string") {
    return { type: "redacted_thinking", data: value.data };
  }
  if (
    value.type === "tool_use"
    && typeof value.id === "string"
    && typeof value.name === "string"
  ) {
    return {
      type: "tool_use",
      id: value.id,
      name: value.name,
      input: value.input,
      ...(isRecord(value.caller) ? { caller: value.caller as never } : {}),
    };
  }
  return undefined;
}

function replayMarker(value: unknown): AnthropicReplayMarker | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[ANTHROPIC_REPLAY_KEY];
  if (!isRecord(candidate) || typeof candidate.responseId !== "string") return undefined;
  if (!Array.isArray(candidate.content) || candidate.content.length === 0) return undefined;
  const content = candidate.content.map(replayableBlock);
  if (content.some((block) => block === undefined)) return undefined;
  return Object.freeze({
    responseId: candidate.responseId,
    content: Object.freeze(content as ContentBlockParam[]),
  });
}

function toReplayContent(content: readonly ContentBlock[]): readonly ContentBlockParam[] {
  const replay = content.map(replayableBlock);
  if (replay.some((block) => block === undefined)) {
    throw new Error("Claude returned a content block Albert cannot replay safely.");
  }
  return Object.freeze(replay as ContentBlockParam[]);
}

function providerDataFor(marker: AnthropicReplayMarker): Record<string, unknown> {
  return { [ANTHROPIC_REPLAY_KEY]: marker };
}

function textFromUserContent(item: Extract<AgentInputItem, { role: "user" }>): ContentBlockParam[] {
  if (typeof item.content === "string") return [{ type: "text", text: item.content }];
  return item.content.map((content) => {
    if (content.type !== "input_text") {
      throw new Error("Claude currently accepts text-only Albert conversation input.");
    }
    return {
      type: "text" as const,
      text: wireText(content.text),
      ...(content.promptCacheBreakpoint?.mode === "explicit"
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    };
  });
}

function textFromAssistantContent(
  item: Extract<AgentInputItem, { role: "assistant" }>,
): ContentBlockParam[] {
  return item.content.map((content) => {
    if (content.type === "output_text") return { type: "text" as const, text: wireText(content.text) };
    if (content.type === "refusal") return { type: "text" as const, text: wireText(content.refusal) };
    throw new Error("Claude cannot replay non-text assistant content in this runtime.");
  });
}

function toolResultText(output: Extract<AgentInputItem, { type: "function_call_result" }>["output"]): string {
  if (typeof output === "string") return wireText(output);
  if (Array.isArray(output)) {
    return wireText(output.map((item) => {
      if (item.type === "input_text") return item.text;
      return JSON.stringify(item);
    }).join("\n"));
  }
  if (isRecord(output) && output.type === "text" && typeof output.text === "string") {
    return wireText(output.text);
  }
  return wireText(JSON.stringify(output));
}

function parseToolArguments(value: string, toolName: string): unknown {
  try {
    // Well-forming the serialized arguments repairs lone surrogates in every
    // nested string value before they can reach the wire.
    return JSON.parse(wireText(value || "{}"));
  } catch {
    throw new Error(`Claude could not replay invalid arguments for ${toolName}.`);
  }
}

function toAnthropicConversation(request: ModelRequest): Readonly<{
  system: string | undefined;
  messages: MessageParam[];
}> {
  const messages: MessageParam[] = [];
  const systemParts = request.systemInstructions?.trim()
    ? [request.systemInstructions.trim()]
    : [];
  const replayedResponses = new Set<string>();

  const append = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    // The API rejects text blocks without visible content; they also carry
    // nothing, so they are dropped rather than failing the whole request.
    const content = blocks.filter((block) => block.type !== "text" || block.text.trim().length > 0);
    if (content.length === 0) return;
    const previous = messages.at(-1);
    if (previous?.role === role && Array.isArray(previous.content)) {
      previous.content.push(...content);
      return;
    }
    messages.push({ role, content });
  };

  if (typeof request.input === "string") {
    append("user", [{ type: "text", text: request.input }]);
  } else {
    for (const item of request.input) {
      const marker = replayMarker(item.providerData);
      if (marker) {
        if (!replayedResponses.has(marker.responseId)) {
          append("assistant", [...marker.content]);
          replayedResponses.add(marker.responseId);
        }
        continue;
      }

      if ((item.type === undefined || item.type === "message") && item.role === "system") {
        if (item.content.trim()) systemParts.push(item.content.trim());
        continue;
      }
      if ((item.type === undefined || item.type === "message") && item.role === "user") {
        append("user", textFromUserContent(item));
        continue;
      }
      if ((item.type === undefined || item.type === "message") && item.role === "assistant") {
        append("assistant", textFromAssistantContent(item));
        continue;
      }
      if (item.type === "reasoning") {
        // Provider-authored thinking is replayed only from the signed marker
        // above. Never translate public summaries back into private thinking.
        continue;
      }
      if (item.type === "function_call") {
        append("assistant", [{
          type: "tool_use",
          id: item.callId,
          name: item.name,
          input: parseToolArguments(item.arguments, item.name),
        }]);
        continue;
      }
      if (item.type === "function_call_result") {
        append("user", [{
          type: "tool_result",
          tool_use_id: item.callId,
          content: toolResultText(item.output),
          ...(item.status === "incomplete" ? { is_error: true } : {}),
        }]);
        continue;
      }
      throw new Error(`Claude does not support Albert input item ${item.type ?? "unknown"}.`);
    }
  }

  if (messages.length === 0) {
    throw new Error("Claude requires at least one conversation message.");
  }
  return {
    system: systemParts.length > 0 ? wireText(systemParts.join("\n\n")) : undefined,
    messages,
  };
}

/**
 * Prompt caching. Anthropic caches only up to explicit `cache_control`
 * breakpoints, and Albert's agent loops re-send the whole conversation on
 * every tool step, so without breakpoints each step pays full price and full
 * prefill time for a prefix the previous step already processed. Marking the
 * final content block of the last message lets each request read the prior
 * step's prefix from cache and write only the new tail (the API looks back
 * from a breakpoint for the longest cached prefix). Together with the system
 * breakpoint this uses two of the four allowed; callers' explicit breakpoints
 * are left untouched.
 */
function withTrailingCacheBreakpoint(messages: readonly MessageParam[]): MessageParam[] {
  const last = messages.at(-1);
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return [...messages];
  const blocks = [...last.content];
  const tail = blocks[blocks.length - 1]!;
  // Thinking and tool_use blocks cannot carry a breakpoint; in the agent loop
  // the last message is always the user turn (question or tool results).
  if (tail.type !== "text" && tail.type !== "tool_result") return [...messages];
  if (tail.cache_control) return [...messages];
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

function toAnthropicTools(request: ModelRequest): Tool[] {
  const tools: Tool[] = [];
  for (const tool of request.tools) {
    if (tool.type !== "function") {
      throw new Error(`Claude does not support hosted Albert tool ${tool.name}.`);
    }
    tools.push({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: transformedObjectSchema(tool.parameters),
      strict: tool.strict,
    });
  }
  for (const handoff of request.handoffs) {
    tools.push({
      name: handoff.toolName,
      description: handoff.toolDescription,
      input_schema: transformedObjectSchema(handoff.inputJsonSchema),
      strict: handoff.strictJsonSchema,
    });
  }
  return tools;
}

function transformedObjectSchema(schema: unknown): Tool.InputSchema {
  if (!isRecord(schema) || schema.type !== "object") {
    throw new Error("Claude requires an object JSON schema.");
  }
  return jsonSchemaOutputFormat(
    schema as Parameters<typeof jsonSchemaOutputFormat>[0],
  ).schema as Tool.InputSchema;
}

function selectedEffort(request: ModelRequest): ReasoningEffort {
  const effort = request.modelSettings.reasoning?.effort;
  if (isReasoningEffort(effort)) return effort;
  return effort === "minimal" ? "low" : "none";
}

function toAnthropicToolChoice(
  request: ModelRequest,
  thinkingEnabled: boolean,
  hasTools: boolean,
): ToolChoice | undefined {
  if (!hasTools) return undefined;
  const choice = request.modelSettings.toolChoice;
  if (choice === "none") return { type: "none" };
  if (!choice || choice === "auto") return { type: "auto" };
  // Anthropic rejects forced tool choice while thinking is on (manual and
  // adaptive alike). Albert's tool-owning agents already instruct the
  // required call, so preserve thinking and let Claude choose automatically
  // rather than emitting a provider-invalid body.
  if (thinkingEnabled) return { type: "auto" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice };
}

function outputFormat(request: ModelRequest): Readonly<{
  config: MessageCreateParamsNonStreaming["output_config"];
  restoreSchema?: Tool.InputSchema;
}> {
  if (request.outputType === "text") return { config: undefined };
  if (request.outputType.type !== "json_schema") {
    throw new Error(`Claude does not support output type ${request.outputType.type}.`);
  }
  const restoreSchema = transformedObjectSchema(request.outputType.schema);
  return {
    config: {
      format: {
        type: "json_schema",
        schema: simplifyNullableOutputSchema(restoreSchema) as Tool.InputSchema,
      },
    },
    restoreSchema,
  };
}

function requestBody(model: string, request: ModelRequest): Readonly<{
  body: MessageCreateParamsNonStreaming;
  effort: ReasoningEffort;
  budgetTokens: number;
  resolvedToolChoice: ToolChoice | undefined;
  schemaPolicy: AnthropicSchemaPolicy;
  outputRestoreSchema?: Tool.InputSchema;
}> {
  if (request.previousResponseId || request.conversationId || request.prompt) {
    throw new Error("Claude uses Albert's explicit bounded context, not provider-managed conversation state.");
  }
  const conversation = toAnthropicConversation(request);
  const requestedTools = toAnthropicTools(request);
  const effort = selectedEffort(request);
  // Haiku 4.5 predates adaptive thinking: Albert's efforts map onto manual
  // budget_tokens there. The 4.6+ family (Sonnet 5) rejects budget_tokens;
  // it takes adaptive thinking plus the provider-native output_config.effort.
  const adaptive = isAlbertModelId(model) && anthropicUsesAdaptiveThinking(model);
  const budgetTokens = adaptive ? 0 : HAIKU_THINKING_BUDGET_TOKENS[effort];
  const thinkingEnabled = adaptive ? effort !== "none" : budgetTokens > 0;
  const resolvedOutput = outputFormat(request);
  const schemaBudget = applyAnthropicSchemaBudget(requestedTools, resolvedOutput.config);
  const tools = schemaBudget.tools;
  const providerMaxTokens = isAlbertModelId(model) ? anthropicMaxOutputTokens(model) : 64_000;
  const configuredMax = request.modelSettings.maxTokens;
  const maxTokens = configuredMax
    ?? (adaptive ? ANTHROPIC_ADAPTIVE_DEFAULT_MAX_OUTPUT_TOKENS : HAIKU_MAX_OUTPUT_TOKENS[effort]);
  if (
    !Number.isSafeInteger(maxTokens)
    || maxTokens < 1
    || maxTokens > providerMaxTokens
    || (budgetTokens > 0 && maxTokens <= budgetTokens)
  ) {
    throw new Error(`Claude max tokens must be positive, at most ${providerMaxTokens}, and greater than any manual thinking budget.`);
  }
  let outputConfig = resolvedOutput.config;
  if (adaptive && effort !== "none") {
    outputConfig = { ...(outputConfig ?? {}), effort };
  }
  const resolvedToolChoice = toAnthropicToolChoice(request, thinkingEnabled, tools.length > 0);
  const body: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages: withTrailingCacheBreakpoint(conversation.messages),
    // The system prompt is the stable prefix of every request in a turn (and
    // of every turn in a conversation); its breakpoint also covers the tool
    // definitions, which the API renders ahead of it.
    ...(conversation.system
      ? { system: [{ type: "text" as const, text: conversation.system, cache_control: { type: "ephemeral" as const } }] }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(resolvedToolChoice ? { tool_choice: resolvedToolChoice } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
    thinking: adaptive
      ? (thinkingEnabled ? { type: "adaptive", display: "omitted" } : { type: "disabled" })
      : budgetTokens > 0
        ? { type: "enabled", budget_tokens: budgetTokens, display: "omitted" }
        : { type: "disabled" },
    service_tier: "standard_only",
  };
  return {
    body,
    effort,
    budgetTokens,
    resolvedToolChoice,
    schemaPolicy: schemaBudget.policy,
    ...(resolvedOutput.restoreSchema ? { outputRestoreSchema: resolvedOutput.restoreSchema } : {}),
  };
}

function toUsage(message: Message): Usage {
  const cacheRead = message.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
  const inputTokens = message.usage.input_tokens + cacheRead + cacheWrite;
  const outputTokens = message.usage.output_tokens;
  const inputTokensDetails = {
    cached_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
  const outputTokensDetails: Record<string, number> =
    message.usage.output_tokens_details?.thinking_tokens === undefined
      ? {}
      : { reasoning_tokens: message.usage.output_tokens_details.thinking_tokens };
  return new Usage({
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokensDetails,
    outputTokensDetails,
    requestUsageEntries: [{
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      inputTokensDetails,
      outputTokensDetails,
      endpoint: "messages.create",
    }],
  });
}

function toModelOutput(message: Message, outputRestoreSchema?: Tool.InputSchema): AgentOutputItem[] {
  const replay = toReplayContent(message.content);
  const marker = Object.freeze({ responseId: message.id, content: replay });
  const providerData = providerDataFor(marker);
  const output: AgentOutputItem[] = [];
  const hasThinking = message.content.some(
    (block) => block.type === "thinking" || block.type === "redacted_thinking",
  );
  if (hasThinking) {
    output.push({
      id: `${message.id}:thinking`,
      type: "reasoning",
      content: [],
      providerData,
    });
  }
  const rawText = message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const text = rawText && outputRestoreSchema
    ? normalizeStructuredOutputText(rawText, outputRestoreSchema)
    : rawText;
  if (text) {
    output.push({
      id: message.id,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
      providerData,
    });
  }
  for (const block of message.content) {
    if (block.type !== "tool_use") continue;
    output.push({
      id: block.id,
      type: "function_call",
      callId: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input),
      status: "completed",
      providerData,
    });
  }
  if (output.length === 0) {
    throw new Error("Claude returned no text or tool call Albert can consume.");
  }
  return output;
}

export class AnthropicMessagesModel implements Model {
  constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly model: string = CLAUDE_HAIKU_4_5_MODEL_ID,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const prepared = requestBody(this.model, request);
    // XHigh and Max exceed the SDK's non-streaming long-request threshold.
    // Consume SSE internally and return only the accumulated final Message;
    // provider text/thinking deltas never enter Albert's public trace.
    const openStream = () => this.client.messages.stream(
      prepared.body,
      request.signal ? { signal: request.signal } : undefined,
    );
    let stream = openStream();
    let message: Message;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      // Anthropic occasionally rejects an accepted stream mid-flight with the
      // generic "Invalid request data" error event (observed at high thinking
      // budgets). The SDK's own retries cover only pre-response failures, so
      // one identical re-send handles this transient here.
      const detail = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted || !/Invalid request data/u.test(detail)) throw error;
      stream = openStream();
      message = await stream.finalMessage();
    }
    if (message.stop_reason !== "end_turn" && message.stop_reason !== "tool_use") {
      const reason = message.stop_reason ?? "missing";
      throw new Error(`Claude stopped without a complete Albert response (${reason}).`);
    }
    const requestId = (message as Message & { _request_id?: string })._request_id
      ?? stream.request_id
      ?? undefined;
    return {
      usage: toUsage(message),
      output: toModelOutput(message, prepared.outputRestoreSchema),
      responseId: message.id,
      ...(requestId ? { requestId } : {}),
      providerData: {
        provider: "anthropic",
        model: message.model,
        stop_reason: message.stop_reason,
        service_tier: message.usage.service_tier,
        thinking: prepared.body.thinking,
        reasoning_level: prepared.effort,
        tool_choice: prepared.resolvedToolChoice?.type ?? "none",
        schema_policy: prepared.schemaPolicy,
      },
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    // Albert currently runs model calls non-streaming and streams its governed
    // trace. Keep the interface complete without exposing provider thinking:
    // one native call, one bounded text delta, then the normalized response.
    yield { type: "response_started" };
    const response = await this.getResponse(request);
    for (const item of response.output) {
      if (!("role" in item) || item.role !== "assistant" || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (content.type === "output_text" && content.text) {
          yield { type: "output_text_delta", itemId: item.id, delta: content.text };
        }
      }
    }
    yield {
      type: "response_done",
      response: {
        id: response.responseId ?? `anthropic_${Date.now()}`,
        ...(response.requestId ? { requestId: response.requestId } : {}),
        usage: response.usage,
        output: response.output,
        providerData: response.providerData,
      },
    } as StreamEvent;
  }
}

export class AnthropicMessagesModelProvider implements ModelProvider {
  private readonly model: AnthropicMessagesModel;

  constructor(client: AnthropicMessagesClient, private readonly modelId = CLAUDE_HAIKU_4_5_MODEL_ID) {
    this.model = new AnthropicMessagesModel(client, modelId);
  }

  getModel(modelName?: string): Model {
    if (modelName && modelName !== this.modelId) {
      throw new Error(`Anthropic provider cannot resolve unsupported model ${modelName}.`);
    }
    return this.model;
  }
}

export function createAnthropicMessagesModelProvider(
  transport: ResolvedAlbertModelTransport,
): ModelProvider {
  if (transport.provider !== "anthropic" || !isAnthropicModel(transport.model)) {
    throw new Error("Anthropic Messages provider received the wrong Albert transport.");
  }
  const client = new Anthropic({
    apiKey: transport.apiKey,
    baseURL: transport.baseUrl,
    maxRetries: 2,
  });
  return new AnthropicMessagesModelProvider(client as AnthropicMessagesClient, transport.model);
}

/** Exposed only for deterministic wire-contract tests. */
export const anthropicMessagesRequestForTest = requestBody;
