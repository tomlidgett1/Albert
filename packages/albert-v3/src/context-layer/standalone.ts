/**
 * Standalone refresh: run the business-context refresh outside a normal
 * answering turn, under a lease the caller began for it (the dashboard's
 * "Regenerate" action, or an operator script). Builds the same governed Cube
 * client and model runner the engine uses.
 */
import { Runner } from "@openai/agents";
import { resolveAlbertModelTransport, type AgentRunPreferences } from "../../../shared/src/index.js";
import { createAlbertModelProvider } from "../../../agent/src/responses-provider.js";
import { CubeClient } from "../cube/client.js";
import { loadAgentConfig } from "../agent-config/loader.js";
import { trackRunnerUsage } from "../engine/usage-accounting.js";
import { deriveConnectorFreshness } from "../engine/freshness.js";
import { normalizeV3Connector } from "../engine/connector-routing.js";
import type { ConnectorDomainFreshness, TenantSourceFinding } from "../engine/context.js";
import type { ProviderRunUsage } from "../../../usage-metering/src/index.js";
import { runBusinessContextRefresh, type BusinessContextRefreshResult } from "./refresh.js";
import type { BusinessContextDocument, BusinessContextSection } from "./schema.js";
import { createHash } from "node:crypto";

export async function runStandaloneBusinessContextRefresh(input: Readonly<{
  tenantId: string;
  conversationId: string;
  turnId: string;
  cubeApiUrl: string;
  cubeApiSecret: string;
  openaiApiKey: string;
  openaiBaseUrl?: string;
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  preferences: AgentRunPreferences;
  connectorKeys: readonly string[];
  freshness?: readonly ConnectorDomainFreshness[];
  existing?: Readonly<{ document: BusinessContextDocument; ownerLocked: readonly BusinessContextSection[] }>;
  sourceFindings?: readonly TenantSourceFinding[];
  signal?: AbortSignal;
}>): Promise<Readonly<{ result: BusinessContextRefreshResult; usage: ProviderRunUsage; providerResponseId: string | null }>> {
  const config = loadAgentConfig();
  const cube = new CubeClient({
    apiUrl: input.cubeApiUrl,
    apiSecret: input.cubeApiSecret,
    securityContext: { tenant_id: input.tenantId, conversation_id: input.conversationId, turn_id: input.turnId },
  });
  const provider = createAlbertModelProvider(resolveAlbertModelTransport({
    model: input.preferences.model,
    openaiApiKey: input.openaiApiKey,
    openaiBaseUrl: input.openaiBaseUrl,
    xaiApiKey: input.xaiApiKey,
    xaiBaseUrl: input.xaiBaseUrl,
    anthropicApiKey: input.anthropicApiKey,
    anthropicBaseUrl: input.anthropicBaseUrl,
  }));
  const accounting = trackRunnerUsage(new Runner({
    modelProvider: provider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: "albert-business-context",
    groupId: input.conversationId,
  }));
  const activeTrace = [...new Set(input.connectorKeys.map((key) => normalizeV3Connector(key)).filter((k): k is NonNullable<typeof k> => Boolean(k)))];
  const freshness = await deriveConnectorFreshness({
    cube, tenantId: input.tenantId, probes: config.freshnessProbes, activeConnectors: activeTrace, known: input.freshness ?? [], signal: input.signal,
  }).catch(() => input.freshness ?? []);
  const result = await runBusinessContextRefresh({
    cube,
    config,
    connectorKeys: input.connectorKeys,
    freshness,
    preferences: input.preferences,
    runner: accounting.runner,
    cachePartition: createHash("sha256").update(input.tenantId).digest("hex").slice(0, 12),
    existing: input.existing,
    sourceFindings: input.sourceFindings,
    signal: input.signal,
  });
  return { result, usage: accounting.snapshot(), providerResponseId: accounting.lastResponseId() };
}
