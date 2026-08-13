import { createHash } from "node:crypto";
import type { AnswerState, TraceProvenance } from "../../../shared/src/index.js";
import type { Lane } from "./orchestrator.js";
import type { V3TurnContext } from "./context.js";

export const MISSING_QUERY_RETRY_MESSAGE =
  "You returned a final answer without running a governed data query. "
  + "Call run_cube_query, top_n_breakdown, or compare_periods "
  + "(or the matching Shopify query tool) before answering. "
  + "Do not describe what you will do. Retrieve the figures first.";

const UNGROUNDED_FOLLOW_UPS = [
  "Try the question again",
  "Show sales this month",
  "Break this down by product",
] as const;

export type UngroundedFinalAnswer = {
  answer: string;
  state: "Unavailable";
  followUps: string[];
  assumptionsDisclosed: string[];
};

/** Data lanes must execute a query this turn. Explain may rest on prior queries. */
export function laneRequiresQueryEvidence(lane: Lane): boolean {
  return lane === "quick" || lane === "analytical" || lane === "deep";
}

/**
 * Grok (and sometimes other models) fill the structured-output schema with a
 * commitment instead of calling tools. That prose must never ship as an answer.
 */
export function looksLikeUngroundedPlan(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(?:i(?:['’]ll| will| am going to| can)|let me)\b/iu.test(trimmed)
    || /\bi(?:['’]ll| will) (?:now )?(?:break|look|check|pull|run|start|query)\b/iu.test(trimmed);
}

export function ungroundedOwnerAnswer(): string {
  return "I could not retrieve those figures from the connected data. Try the question again.";
}

export function ungroundedFinalAnswer(): UngroundedFinalAnswer {
  return {
    answer: ungroundedOwnerAnswer(),
    state: "Unavailable",
    followUps: [...UNGROUNDED_FOLLOW_UPS],
    assumptionsDisclosed: [],
  };
}

export function emptyTurnProvenance(timezone: string): TraceProvenance {
  return {
    sources: [],
    timeRange: {
      label: "Requested period",
      start: "unknown",
      end: "unknown",
      timezone,
    },
    definitions: [],
    semanticBundleHash: "albert-v3-cube-no-queries",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
}

export function buildTurnProvenance(context: V3TurnContext): TraceProvenance {
  if (context.executedQueries.length === 0) {
    return emptyTurnProvenance(context.config.timezone);
  }
  const now = new Date().toISOString();
  const yamlDigest = createHash("sha256")
    .update(context.executedQueries.map((query) => query.queryYaml).join("\n---\n"))
    .digest("hex")
    .slice(0, 16);
  const firstRange = context.executedQueries[0]?.timeRangeLabel ?? "Requested period";
  const connectors = [...new Set(context.executedQueries.map((query) => query.connector))];
  const connectorLabels: Partial<Record<string, string>> = {
    lightspeed: "Cube semantic layer · Lightspeed (POS)",
    deputy: "Cube semantic layer · Deputy (workforce)",
    xero: "Cube semantic layer · Xero (accounting)",
    shopify: "Official ShopifyQL live report",
  };
  return {
    sources: connectors.map((connector) => ({
      connector,
      label: connectorLabels[connector] ?? `Cube semantic layer · ${connector}`,
      dataThrough: now,
    })),
    timeRange: {
      label: firstRange,
      start: "unknown",
      end: "unknown",
      timezone: context.config.timezone,
    },
    definitions: context.executedQueries.map((query) => ({
      metric: query.view.startsWith("shopifyql:")
        ? `shopifyql.ir:${query.view.slice("shopifyql:".length)}`
        : query.view.startsWith("shopify-admin:")
          ? `shopify-admin.ir:${query.view.slice("shopify-admin:".length)}`
          : `cube.yaml:${query.view}`,
      label: query.topic,
      definition: query.queryYaml,
    })),
    semanticBundleHash: `albert-v3-cube-${yamlDigest}`,
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
}

export function groundedAnswerState(input: Readonly<{
  lane: Lane;
  requested: AnswerState;
  queriesExecuted: number;
  rowsSeen: number;
  /** An empty result window reached past a connector's sync watermark. */
  freshnessQualified?: boolean;
}>): AnswerState {
  let state = input.requested;
  if (input.queriesExecuted === 0 && (state === "Verified" || state === "Exploratory")) {
    state = input.lane === "explain" ? "Exploratory" : "Unavailable";
  }
  if (state === "Verified" && input.rowsSeen === 0) state = "No data";
  // A "verified" emptiness reaching past the sync watermark overstates
  // certainty: the data may simply not have arrived yet.
  if (input.freshnessQualified && (state === "Verified" || state === "No data")) {
    state = "Qualified";
  }
  if (laneRequiresQueryEvidence(input.lane) && input.queriesExecuted === 0) {
    return "Unavailable";
  }
  return state;
}

export function ownerFacingAnswerText(input: Readonly<{
  lane: Lane;
  draft: string;
  queriesExecuted: number;
}>): string {
  if (laneRequiresQueryEvidence(input.lane) && input.queriesExecuted === 0) {
    return ungroundedOwnerAnswer();
  }
  return input.draft;
}
