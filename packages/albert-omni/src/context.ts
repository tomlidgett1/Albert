import type { AgentInputItem } from "@openai/agents";
import type { PriorTurnResult } from "../../albert-v3/src/engine/prior-results.js";
import {
  ALBERT_OMNI_CONTEXT_MAX_BYTES,
  omniPriorResultSchema,
  type OmniServiceTurn,
} from "./contracts.js";

export function omniPriorResults(results: readonly PriorTurnResult[]): NonNullable<OmniServiceTurn["priorResults"]> {
  const selected: NonNullable<OmniServiceTurn["priorResults"]> = [];
  for (const result of results) {
    if (!result.provenance) continue;
    const columns = result.columns.slice(0, 16);
    const rows = result.rows.slice(0, 20).map((row) => Object.fromEntries(columns.map((column) => {
      const value = row[column.key] ?? null;
      return [column.key, typeof value === "string" ? value.slice(0, 200) : value];
    })));
    const parsed = omniPriorResultSchema.safeParse({
      resultId: result.resultId, turnsAgo: result.turnsAgo, caption: result.caption,
      presentation: result.presentation, columns, rows, rowCount: result.rowCount,
      ...(result.view ? { view: result.view } : {}),
      connector: result.connector ?? result.provenance.sources[0]?.connector,
      sources: result.provenance.sources.slice(0, 8),
      timeRange: result.provenance.timeRange,
      definitions: result.provenance.definitions.slice(0, 12).map((definition) => ({ ...definition, definition: definition.definition.slice(0, 500) })),
      semanticBundleHash: result.provenance.semanticBundleHash,
      identityGraph: result.provenance.identityGraph,
      ...(result.semantics ? { semantics: { ...result.semantics, returnedRows: rows.length, completeness: rows.length < result.rowCount ? "limited" : result.semantics.completeness } } : {}),
      ...(result.rowFormats ? { rowFormats: result.rowFormats.slice(0, rows.length) } : {}),
    });
    if (parsed.success) selected.push(parsed.data);
    if (selected.length >= 8) break;
  }
  return selected;
}

/** Bound the serialized request, including multibyte text and all metadata. */
export function boundOmniTurnContext(turn: OmniServiceTurn, maxBytes = ALBERT_OMNI_CONTEXT_MAX_BYTES): OmniServiceTurn {
  const bounded: OmniServiceTurn = { ...turn, priorConversation: [...turn.priorConversation], priorResults: structuredClone(turn.priorResults ?? []) };
  const bytes = () => Buffer.byteLength(JSON.stringify(bounded), "utf8");
  while (bytes() > maxBytes && bounded.priorConversation.length > 2) bounded.priorConversation.splice(0, 2);
  while (bytes() > maxBytes && (bounded.priorResults?.length ?? 0) > 1) bounded.priorResults!.pop();
  if (bytes() > maxBytes && bounded.businessContext) bounded.businessContext = bounded.businessContext.slice(0, 2_000);
  while (bytes() > maxBytes && bounded.priorResults?.[0]?.rows.length) {
    const result = bounded.priorResults[0];
    result.rows = result.rows.slice(0, Math.floor(result.rows.length / 2));
    if (result.semantics) result.semantics = { ...result.semantics, completeness: "limited", returnedRows: result.rows.length };
    if (result.rowFormats) result.rowFormats = result.rowFormats.slice(0, result.rows.length);
  }
  while (bytes() > maxBytes && bounded.priorConversation.length) bounded.priorConversation.shift();
  if (bytes() > maxBytes) delete bounded.priorResults;
  if (bytes() > maxBytes) delete bounded.businessContext;
  if (bytes() > maxBytes) throw new Error("The question and required context exceed the safe request size.");
  return bounded;
}

/** A partial provider stream may leave tool calls without results. Never replay orphan pairs. */
export function completedAgentHistory(history: readonly AgentInputItem[]): AgentInputItem[] {
  const completeCalls = new Set(history.flatMap((item) => item.type === "function_call_result" && item.status === "completed" ? [item.callId] : []));
  const calls = new Set(history.flatMap((item) => item.type === "function_call" ? [item.callId] : []));
  return history.filter((item) => item.type === "function_call" ? completeCalls.has(item.callId)
    : item.type === "function_call_result" ? completeCalls.has(item.callId) && calls.has(item.callId)
      : true).map((item) => structuredClone(item));
}

/** Keep evidence in the registry while sending bounded previews to the model. */
export function compactOmniModelHistory(history: readonly AgentInputItem[], targetBytes = 256_000): AgentInputItem[] {
  const output = [...history];
  let bytes = Buffer.byteLength(JSON.stringify(output));
  if (bytes <= targetBytes) return output;
  for (let index = 0; index < output.length && bytes > targetBytes; index++) {
    const item = output[index]!;
    if (item.type !== "function_call_result" || typeof item.output !== "string") continue;
    const before = Buffer.byteLength(item.output);
    if (before < 2_000) continue;
    let compacted: string | undefined;
    try {
      const value = JSON.parse(item.output) as Record<string, unknown>;
      if (typeof value.resultId === "string" && Array.isArray(value.rows)) {
        compacted = JSON.stringify({ ...value, rows: value.rows.slice(0, index >= output.length - 3 ? 8 : 0), truncated: true, contextNote: "Older rows were removed only from model context. The complete retained result remains available by resultId for DeriveResult, CalculateValues, charts and answer composition. Refine a governed query to inspect a smaller slice." });
      }
    } catch {
      if (item.name === "SearchSemanticModel" && index < output.length - 6) compacted = "Earlier schema definitions were compacted. Repeat SearchSemanticModel for the topic when exact definitions are needed; repeated topic inspection does not consume a new search allowance.";
    }
    if (!compacted) continue;
    output[index] = { ...item, output: compacted };
    bytes -= before - Buffer.byteLength(compacted);
  }
  return output;
}
