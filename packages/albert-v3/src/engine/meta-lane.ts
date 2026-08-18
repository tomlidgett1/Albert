/**
 * The meta lane: questions about Albert's data rather than the business.
 *
 * "What's connected?", "How fresh is my data?", "What date range do you have?",
 * "Is Shopify connected?", "Do you have payroll data?" used to go through the
 * quick/analytical lanes, which answered them by running probing queries — slow,
 * and prone to naming tools that are merely configured rather than connected.
 * The engine already knows the answers: the tenant's connected tools, the
 * governed views per tool, the data-derived and control-plane watermarks, and
 * the recorded source findings. This lane assembles that fact sheet and makes
 * one bounded composition call. It is connector-agnostic by construction —
 * every fact comes from the registry, the config, or the freshness contract.
 */
import { Agent, user } from "@openai/agents";
import { sanitizeTraceText } from "../../../shared/src/index.js";
import type { V3TurnContext } from "./context.js";
import { normalizeV3Connector } from "./connector-routing.js";
import { CONNECTOR_LABELS } from "./orchestrator.js";
import { ANSWER_CONTRACT, finalAnswerSchema, laneModelSettings, renderSourceFindings, todayLine, v3PromptCacheKey, withV3PromptCacheBoundary, type FinalAnswer, type LaneRunInput } from "./lanes.js";
import { NATIVE_CAPABILITIES } from "./native-capabilities.js";

export function renderDataFactSheet(input: LaneRunInput, activeConnectors: readonly string[] | undefined): string {
  const config = input.config;
  const active = [...new Set((activeConnectors ?? []).map((key) => normalizeV3Connector(key)).filter((k): k is NonNullable<typeof k> => Boolean(k)))];
  const configured = [...new Set(config.accessibleViews.map((view) => view.connector))];
  const connected = active.length > 0 ? active : configured;
  const notConnected = configured.filter((connector) => !connected.includes(connector));
  const lines: string[] = [];
  if (input.context.businessContext) {
    lines.push(input.context.businessContext.rendered, "");
  }
  lines.push("# Connected tools (the ONLY sources of data for this business)");
  for (const connector of connected) {
    const views = config.accessibleViews.filter((view) => view.connector === connector);
    lines.push(`- ${connector}: ${CONNECTOR_LABELS[connector] ?? connector}. Data areas: ${views.map((view) => `${view.name.replace(/_analytics$/u, "").replace(/_/gu, " ")} — ${(view.purpose ?? view.guidance).replace(/\s+/gu, " ").slice(0, 90)}`).join("; ")}`);
    const native = NATIVE_CAPABILITIES.filter((capability) => capability.connectorKeys.some((key) => normalizeV3Connector(key) === connector || key === connector));
    for (const capability of native) lines.push(`  live from ${connector} itself: ${capability.kinds.map((k) => k.kind.replace(/_/gu, " ")).join(", ")}`);
  }
  lines.push("", "# Not connected (Albert has no data from these; say so plainly if asked)", notConnected.length > 0 ? `- ${notConnected.map((connector) => CONNECTOR_LABELS[connector] ?? connector).join(", ")}` : "- (every configured tool is connected)");
  lines.push("", "# Data coverage and freshness (per tool and area; dates are the latest business date holding data)");
  if (input.context.connectorFreshness.length === 0) lines.push("- no watermarks available this turn");
  for (const entry of input.context.connectorFreshness) {
    lines.push(`- ${entry.connector} ${entry.domain}: ${entry.dataFrom ? `from ${entry.dataFrom} ` : ""}${entry.dataThrough ? `through ${entry.dataThrough.slice(0, 10)}` : "latest date unknown"}`);
  }
  const findings = renderSourceFindings(input.context.sourceFindings);
  if (findings) lines.push("", findings);
  return lines.join("\n");
}

const META_INSTRUCTIONS = `You are Albert, answering a question about the data you hold for this business (what is connected,
how fresh it is, what date range exists, what you can and cannot answer). Answer ONLY from the fact
sheet below — it is authoritative and complete. Never name a tool that is not in the connected list as
if it were connected; if the owner asks about one that is not connected, say so plainly and offer the
closest connected source. Give concrete dates when the fact sheet has them. Keep it short: a few
sentences or a compact bullet list; a table only if the owner asks for a breakdown per tool.
No methodology, no hedging, no offers of help. state=Verified — except when the owner asks for a
concrete date or figure the fact sheet does not hold (a latest-transaction date whose watermark is
"latest date unknown", a count, a range): then return state=Escalate with a one-line answer, so a
data query can find it; never tell the owner the date is unavailable.

${ANSWER_CONTRACT}`;

export async function runMetaLane(input: LaneRunInput, activeConnectors: readonly string[] | undefined): Promise<FinalAnswer | undefined> {
  const factSheet = renderDataFactSheet(input, activeConnectors);
  const agent = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 meta lane",
    instructions: `${META_INSTRUCTIONS}\n\n${todayLine(input.config.timezone)}\n\n${factSheet}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({ partition: input.context.promptCachePartition, profile: "meta-lane", route: input.context.toolRoute }),
    }),
    outputType: finalAnswerSchema,
  });
  try {
    const run = await input.runner.run(agent, withV3PromptCacheBoundary(input.preferences.model, [
      ...input.conversation,
      user(`Question: ${sanitizeTraceText(input.intent.resolvedQuestion, 600)}`),
    ]), { context: input.context, maxTurns: 2, signal: input.signal ?? input.context.signal });
    return run.finalOutput;
  } catch (error) {
    if (error instanceof Error && /max turns/iu.test(error.message)) return undefined;
    throw error;
  }
}
