import { Runner, Usage } from "@openai/agents";
import type { ProviderRunUsage } from "../../../usage-metering/src/index.js";

type RunResultLike = {
  runContext?: { usage?: Usage };
  lastResponseId?: string | null;
};

function snapshotProviderUsage(usage: Usage): ProviderRunUsage {
  return Object.freeze({
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: Object.freeze(
      (usage.inputTokensDetails ?? []).map((detail) => Object.freeze({ ...detail })),
    ),
    outputTokensDetails: Object.freeze(
      (usage.outputTokensDetails ?? []).map((detail) => Object.freeze({ ...detail })),
    ),
    requestUsageEntries: usage.requestUsageEntries?.map((entry) => Object.freeze({
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      inputTokensDetails: Object.freeze({ ...entry.inputTokensDetails }),
      outputTokensDetails: Object.freeze({ ...entry.outputTokensDetails }),
      ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
    })),
  });
}

/**
 * Accumulates Agents SDK usage across every lane run on this turn, including
 * intent classification and table repair.
 */
export function trackRunnerUsage(runner: Runner): {
  runner: Runner;
  snapshot: () => ProviderRunUsage;
  lastResponseId: () => string | null;
} {
  const bucket = new Usage();
  let lastResponseId: string | null = null;
  const originalRun = runner.run.bind(runner) as (
    ...args: never[]
  ) => Promise<RunResultLike>;
  const tracked = new Proxy(runner, {
    get(target, property, receiver) {
      if (property === "run") {
        return async (...args: never[]) => {
          const result = await originalRun(...args);
          const usage = result.runContext?.usage;
          if (usage) bucket.add(usage);
          if (typeof result.lastResponseId === "string" && result.lastResponseId.length > 0) {
            lastResponseId = result.lastResponseId;
          }
          return result;
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    runner: tracked,
    snapshot: () => snapshotProviderUsage(bucket),
    lastResponseId: () => lastResponseId,
  };
}
