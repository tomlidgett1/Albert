import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TraceEvent, TraceProvenance, TraceTableColumn } from "../../shared/src/index.js";
import {
  describeLightspeedTable,
  searchLightspeedCatalogue,
  type LightspeedCatalogue,
} from "./catalogue.js";
import type { ExecutedResult } from "./grounding.js";
import { AnthropicSemanticClient, type AnthropicToolContext } from "./semantic-client.js";
import { assertAnthropicSqlPolicy } from "./source-policy.js";

type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, "id" | "sequence" | "occurredAt">
    : never
  : never;
type EmitTrace = (event: TraceEventInput) => void;

type AnthropicSqlToolInput = Readonly<{
  sql: string;
  purpose: string;
  objectiveId: string;
  decompositionOf?: string;
  claims: readonly Readonly<{ metricId: string; column: string }>[];
  time?: Readonly<{ from: string; to: string }>;
  filters: readonly Readonly<Record<string, unknown>>[];
  limit: number;
}>;

/** The objective fields belong to this runtime's repair controller, not to the
 * strict semantic-query API. Keep the boundary explicit so agent-only control
 * metadata can never leak into the governed SQL request. */
export function toGovernedSqlRequest(input: AnthropicSqlToolInput) {
  const { objectiveId: _objectiveId, decompositionOf: _decompositionOf, ...request } = input;
  void _objectiveId;
  void _decompositionOf;
  return request;
}

export type AnthropicToolLedger = {
  readonly results: ExecutedResult[];
  readonly checkpoints: Readonly<Record<string, unknown>>[];
  readonly queryAuditIds: string[];
  readonly mirrorErrors: string[];
  sqlAttempts: number;
  sqlSuccesses: number;
  sqlFailures: number;
};

function textResult(value: unknown, isError = false) {
  const structuredContent = value && typeof value === "object" ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The governed analytics operation failed.";
  return error.message.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500);
}

const sourceInstructionPattern = /(?:ignore\s+(?:all\s+)?(?:previous|prior|system)|system\s+(?:message|prompt)|developer\s+message|assistant\s*:|tool(?:_|\s+)call|reveal\s+(?:secrets?|credentials?)|exfiltrat|<\|(?:system|assistant|tool))/iu;

/** Source text is data, never an instruction channel. Non-scalar text remains
 * readable, but instruction-shaped fragments are replaced before Claude sees
 * a tool result. The evidence ledger retains the exact governed cell for host
 * grounding and never trusts this display projection. */
export function sanitizeAgentSourceValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 2_000);
  if (!sourceInstructionPattern.test(normalized)) return normalized;
  return Object.freeze({ untrustedSourceText: "[instruction-shaped source text removed by policy]" });
}

function rowsForAgent(rows: readonly Readonly<Record<string, unknown>>[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sanitizeAgentSourceValue(value)])));
}

function traceColumn(key: string, rows: readonly Readonly<Record<string, unknown>>[]): TraceTableColumn {
  const sample = rows.map((row) => row[key]).find((value) => value !== null && value !== undefined);
  const lower = key.toLowerCase();
  const type: TraceTableColumn["type"] =
    typeof sample === "number" ? (/(percent|percentage|rate|margin)/u.test(lower) ? "percent" : /(amount|cost|revenue|sales|total|profit|price)/u.test(lower) ? "currency" : "number")
      : /(^|_)(date|day)$/u.test(lower) ? "date"
        : /(time|timestamp|_at)$/u.test(lower) ? "datetime"
          : "string";
  return Object.freeze({ key, label: key.replaceAll("_", " "), type });
}

function sourceConnector(value: string): TraceProvenance["sources"][number]["connector"] {
  if (/xero/iu.test(value)) return "xero";
  if (/deputy/iu.test(value)) return "deputy";
  return "lightspeed";
}

function traceProvenance(response: ExecutedResult["response"]): TraceProvenance {
  const time = response.provenance.timeRange ?? {};
  const start = typeof time.start === "string" ? time.start : "unknown";
  const end = typeof time.end === "string" ? time.end : "unknown";
  const timezone = typeof time.timezone === "string" ? time.timezone : "Australia/Melbourne";
  const sourceDetails = response.provenance.sourceDetails;
  const sources = (sourceDetails.length > 0 ? sourceDetails : response.provenance.sources.map((source) => ({ connectorId: source, label: source })))
    .slice(0, 12)
    .map((raw) => {
      const connectorId = typeof raw.connectorId === "string" ? raw.connectorId : "lightspeed";
      const label = typeof raw.label === "string" ? raw.label : connectorId;
      const record = raw as Record<string, unknown>;
      const watermark = typeof record.dataThrough === "string"
        ? record.dataThrough
        : response.provenance.sourceWatermarks[connectorId] ?? "unknown";
      return { connector: sourceConnector(connectorId), label, dataThrough: watermark };
    });
  return Object.freeze({
    sources: Object.freeze(sources),
    timeRange: Object.freeze({
      label: typeof time.label === "string" ? time.label : "Requested period",
      start,
      end,
      timezone,
    }),
    definitions: Object.freeze(response.provenance.definitionsApplied.slice(0, 20).map((metric) => ({
      metric,
      label: metric,
      definition: metric,
    }))),
    semanticBundleHash: response.provenance.bundleHash.replace(/^sha256:/u, ""),
    identityGraph: Object.freeze({
      version: response.provenance.identityGraph.version,
      hash: response.provenance.identityGraph.hash,
    }),
  });
}

function publicSemanticContext(response: Awaited<ReturnType<AnthropicSemanticClient["execute"]>>) {
  const safe = { ...response };
  delete safe.queryAudit;
  return safe.data
    ? { ...safe, data: { ...safe.data, rows: rowsForAgent(safe.data.rows) } }
    : safe;
}

export function createAnthropicAnalyticsMcp(input: Readonly<{
  catalogue: LightspeedCatalogue;
  semanticClient: AnthropicSemanticClient;
  context: AnthropicToolContext;
  ledger: AnthropicToolLedger;
  emit: EmitTrace;
}>) {
  const repairAttempts = new Map<string, number>();
  const decomposedObjectives = new Set<string>();

  const semanticContext = tool(
    "semantic_context",
    "Search governed metrics and fields, load definitions and capabilities, inspect field values, or check data health before writing SQL.",
    {
      action: z.enum(["search", "definition", "capabilities", "field_values", "health"]),
      value: z.string().trim().min(1).max(2_000),
      query: z.string().trim().max(200).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async (args) => {
      const mapping = {
        search: ["search_catalogue", { question: args.value }],
        definition: ["get_definition", { name: args.value }],
        capabilities: ["get_capabilities", { topic: args.value }],
        field_values: ["list_field_values", { field: args.value, query: args.query, limit: args.limit }],
        health: ["get_data_health", { domain: args.value }],
      } as const;
      const [name, toolInput] = mapping[args.action];
      input.emit({ type: "progress", status: "running", label: `Checking ${args.action.replace("_", " ")}`, detail: args.value, stage: args.action === "search" ? "catalogue" : args.action === "definition" ? "definition" : args.action === "capabilities" ? "capabilities" : args.action === "field_values" ? "field_values" : "data_health" });
      try {
        const response = await input.semanticClient.execute(name, toolInput, input.context);
        return textResult(publicSemanticContext(response));
      } catch (error) {
        return textResult({ error: safeMessage(error), recoverable: true }, true);
      }
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );

  const lightspeedSchema = tool(
    "lightspeed_schema",
    "Search or describe the allowlisted source_lightspeed staging catalogue. Returns table grain, keys, columns, PII and correctness gotchas; it never queries data.",
    {
      action: z.enum(["search", "describe"]),
      query: z.string().trim().min(1).max(500).optional(),
      tables: z.array(z.string().regex(/^ls_[a-z0-9_]+$/)).max(4).optional(),
      limit: z.number().int().min(1).max(12).default(6),
    },
    async (args) => {
      if (args.action === "search") {
        if (!args.query) return textResult({ error: "query is required for schema search" }, true);
        const matches = searchLightspeedCatalogue(input.catalogue, args.query, args.limit);
        return textResult({
          tables: matches.map((table) => ({ relation: `source_lightspeed.${table.id}`, domain: table.domain, grain: table.grain, description: table.description, primaryKey: table.primaryKey })),
        });
      }
      const names = args.tables ?? [];
      if (names.length === 0) return textResult({ error: "tables are required for schema description" }, true);
      const byId = new Map(input.catalogue.tables.map((table) => [table.id, table]));
      const missing = names.filter((name) => !byId.has(name));
      if (missing.length > 0) return textResult({ error: `Unknown allowlisted tables: ${missing.join(", ")}` }, true);
      return textResult({ tables: names.map((name) => describeLightspeedTable(byId.get(name)!)) });
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );

  const sqlExecute = tool(
    "sql_execute",
    "Execute one read-only SELECT/CTE through Albert's signed semantic query service. Tenant and role are injected by trusted code. SQL is linted, scoped, canaried and claim-attested before results are returned.",
    {
      sql: z.string().trim().min(1).max(8_000),
      purpose: z.string().trim().min(1).max(300),
      objectiveId: z.string().regex(/^objective_[a-z0-9_]{1,80}$/),
      decompositionOf: z.string().regex(/^objective_[a-z0-9_]{1,80}$/).optional(),
      claims: z.array(z.object({ metricId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/), column: z.string().regex(/^[a-z_][a-z0-9_]*$/) }).strict()).max(8).default([]),
      time: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().optional(),
      filters: z.array(z.object({ field: z.string(), operator: z.string(), value: z.unknown() }).passthrough()).max(10).default([]),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async (args) => {
      input.ledger.sqlAttempts += 1;
      const repairKey = args.objectiveId;
      if (args.decompositionOf) {
        const parentAttempts = repairAttempts.get(args.decompositionOf) ?? 0;
        if (parentAttempts < 3) {
          input.ledger.sqlFailures += 1;
          return textResult({ error: "A simpler decomposition is allowed only after three failed attempts for its parent objective.", repairExhausted: false }, true);
        }
        if (decomposedObjectives.has(args.decompositionOf)) {
          input.ledger.sqlFailures += 1;
          return textResult({ error: "The single simpler decomposition for this objective was already used. Finish unavailable rather than guessing.", repairExhausted: true }, true);
        }
        decomposedObjectives.add(args.decompositionOf);
      }
      const attempts = (repairAttempts.get(repairKey) ?? 0) + 1;
      repairAttempts.set(repairKey, attempts);
      const attemptLimit = args.decompositionOf ? 1 : 3;
      if (attempts > attemptLimit) {
        input.ledger.sqlFailures += 1;
        return textResult({ error: "The SQL attempt budget for this objective is exhausted. Finish unavailable rather than guessing.", repairExhausted: true }, true);
      }
      try {
        assertAnthropicSqlPolicy({ sql: args.sql, catalogue: input.catalogue, time: args.time });
      } catch (error) {
        input.ledger.sqlFailures += 1;
        return textResult({ error: safeMessage(error), attempt: attempts, attemptsRemaining: Math.max(0, 3 - attempts), recoverable: attempts < 3 }, true);
      }
      input.emit({
        type: "query",
        status: "running",
        topic: args.purpose,
        metrics: args.claims.map((claim) => claim.metricId),
        dimensions: [],
        timeRange: { label: "Requested period", start: args.time?.from ?? "unknown", end: args.time?.to ?? "unknown", timezone: "Australia/Melbourne" },
        lens: args.sql.includes("source_lightspeed.") ? "Lightspeed staging SQL" : "Governed SQL",
      });
      try {
        const response = await input.semanticClient.execute("run_sql", toGovernedSqlRequest(args), input.context);
        if (!response.resultId || !response.data) {
          input.ledger.sqlFailures += 1;
          return textResult({ state: response.state, error: "The governed service returned no tabular result.", validation: response.validation }, true);
        }
        const result: ExecutedResult = Object.freeze({
          resultId: response.resultId,
          state: response.state,
          rows: response.data.rows,
          columns: response.data.columns,
          declaredClaims: args.claims,
          queryAuditId: response.queryAudit?.queryAuditId,
          route: response.queryAudit?.route,
          response,
        });
        input.ledger.results.push(result);
        input.ledger.sqlSuccesses += 1;
        if (response.queryAudit && !input.ledger.queryAuditIds.includes(response.queryAudit.queryAuditId)) input.ledger.queryAuditIds.push(response.queryAudit.queryAuditId);
        input.emit({
          type: "table",
          status: response.state === "unavailable" ? "warning" : "complete",
          caption: args.purpose,
          columns: response.data.columns.map((column) => traceColumn(column, response.data!.rows)),
          rows: response.data.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" || typeof value === "number" || value === null ? value : JSON.stringify(value)]))),
          resultId: response.resultId,
          provenance: traceProvenance(result.response),
        });
        input.emit({
          type: "validation",
          status: response.validation.status === "passed" ? "complete" : "warning",
          name: "Governed SQL validation",
          outcome: response.validation.status === "passed" ? "passed" : response.validation.status === "blocked" || response.validation.status === "failed" ? "failed" : "qualified",
          detail: response.validation.warnings.join(" ").slice(0, 500) || `${response.state} evidence returned from the signed semantic service.`,
        });
        return textResult({
          state: response.state,
          resultId: response.resultId,
          columns: response.data.columns,
          rows: rowsForAgent(response.data.rows),
          resultWindow: response.data.resultWindow,
          validation: response.validation,
          provenance: publicSemanticContext(response).provenance,
        });
      } catch (error) {
        input.ledger.sqlFailures += 1;
        return textResult({ error: safeMessage(error), attempt: attempts, attemptsRemaining: Math.max(0, 3 - attempts), recoverable: attempts < 3 }, true);
      }
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );

  const analysisCheckpoint = tool(
    "analysis_checkpoint",
    "Record a bounded, non-authoritative analysis checkpoint: intended facts, grain, and remaining uncertainty. This grants no data or execution authority.",
    {
      objective: z.string().trim().min(1).max(300),
      facts: z.array(z.string().trim().min(1).max(200)).max(12),
      grain: z.string().trim().min(1).max(200),
      uncertainty: z.array(z.string().trim().min(1).max(200)).max(8),
    },
    async (args) => {
      input.ledger.checkpoints.push(Object.freeze({ ...args }));
      return textResult({ recorded: true, checkpointNumber: input.ledger.checkpoints.length });
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );

  return createSdkMcpServer({
    name: "albert_analytics",
    version: "1.0.0",
    instructions: "Only these tools may be used. SQL remains behind Albert's signed, read-only semantic boundary.",
    alwaysLoad: true,
    tools: [semanticContext, lightspeedSchema, sqlExecute, analysisCheckpoint],
  });
}

export const ANTHROPIC_ALLOWED_TOOLS = Object.freeze([
  "mcp__albert_analytics__semantic_context",
  "mcp__albert_analytics__lightspeed_schema",
  "mcp__albert_analytics__sql_execute",
  "mcp__albert_analytics__analysis_checkpoint",
]);
