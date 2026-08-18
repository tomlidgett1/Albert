import { createHash } from "node:crypto";
import OpenAI from "openai";
import {
  clampReasoningEffort,
  resolveAlbertModelTransport,
  sanitizeAnswerText,
  sanitizeTraceText,
  serviceTierForPreferences,
  type AgentRunPreferences,
  type AnswerState,
  type TraceProvenance,
} from "../../shared/src/index.js";
import type { EmitTrace } from "../../../services/conversation/src/trace-emitter.js";
import { XeroMcpClient } from "./client.js";
import {
  financialYearToDateArgs,
  melbourneToday,
  normaliseProfitAndLossArgs,
  xeroToolTextFailed,
} from "./reports.js";
import type { XeroMcpOrganisation, XeroMcpTool, XeroMcpToolResult } from "./types.js";

export const ALBERT_XERO_MCP_RUNTIME = "xero-mcp" as const;

export type XeroMcpConversationMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
}>;

export type XeroMcpTurnOptions = Readonly<{
  message: string;
  conversation: readonly XeroMcpConversationMessage[];
  preferences: AgentRunPreferences;
  client: XeroMcpClient;
  openaiApiKey: string;
  openaiBaseUrl?: string;
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  signal?: AbortSignal;
  emit: EmitTrace;
}>;

export type XeroMcpTurnResult = Readonly<{
  answerState: AnswerState;
  answerText: string;
  organisationName: string;
  toolsUsed: number;
}>;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function provenance(organisation: string): TraceProvenance {
  const today = new Date().toISOString().slice(0, 10);
  return {
    sources: [{
      connector: "xero",
      label: organisation,
      dataThrough: new Date().toISOString(),
    }],
    timeRange: {
      label: "Live Xero",
      start: today,
      end: today,
      timezone: "Australia/Melbourne",
    },
    definitions: [],
    semanticBundleHash: `xero-mcp-official-${digest(organisation).slice(0, 12)}`,
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
}

function toolLabel(name: string): string {
  return name.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function asFunctionTools(tools: readonly XeroMcpTool[]): OpenAI.Responses.Tool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema.type === "object"
      ? tool.inputSchema
      : { type: "object", properties: {}, additionalProperties: true },
    strict: false,
  }));
}

async function callOfficialTool(
  client: XeroMcpClient,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<XeroMcpToolResult & { organisation: XeroMcpOrganisation; name: string; arguments: Record<string, unknown> }> {
  const attempts = name === "list-profit-and-loss"
    ? profitAndLossAttempts(args)
    : [{ arguments: args }];
  let last: (XeroMcpToolResult & { organisation: XeroMcpOrganisation; name: string }) | undefined;
  for (const attempt of attempts) {
    last = await client.callTool(name, attempt.arguments, signal);
    const failed = last.isError || xeroToolTextFailed(last.text);
    if (!failed) {
      const note = attempt.note ? `${attempt.note}\n` : "";
      return {
        ...last,
        arguments: attempt.arguments,
        text: `${note}${last.text}`,
      };
    }
  }
  return { ...last!, arguments: attempts[attempts.length - 1]!.arguments };
}

function profitAndLossAttempts(args: Record<string, unknown>): ReadonlyArray<{
  arguments: Record<string, unknown>;
  note?: string;
}> {
  const first = normaliseProfitAndLossArgs(args);
  const fy = financialYearToDateArgs();
  const attempts: Array<{ arguments: Record<string, unknown>; note?: string }> = [{
    arguments: first.arguments,
    note: first.reason,
  }];
  if (first.arguments.fromDate !== fy.fromDate || first.arguments.toDate !== fy.toDate) {
    attempts.push({
      arguments: { ...fy },
      note: `Retried list-profit-and-loss for the current Australian FY ${fy.fromDate} to ${fy.toDate}.`,
    });
  }
  attempts.push({
    arguments: {},
    note: "Retried list-profit-and-loss with Xero's default current period.",
  });
  return attempts;
}

function outputText(response: OpenAI.Responses.Response): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const parts: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "output_text") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

export async function runXeroMcpTurn(options: XeroMcpTurnOptions): Promise<XeroMcpTurnResult> {
  const listed = await options.client.listTools(options.signal);
  const organisation = listed.organisation;
  await options.emit({
    type: "progress",
    status: "running",
    stage: "catalogue",
    label: "Connected to the official Xero MCP",
    detail: sanitizeTraceText(organisation.displayName, 160),
    progress: 0.15,
  });
  await options.emit({
    type: "narrative",
    text: sanitizeTraceText(
      `This turn uses Xero's official MCP against ${organisation.displayName}. Only Xero questions are answered.`,
      400,
    ),
  });

  const transport = resolveAlbertModelTransport({
    model: options.preferences.model,
    openaiApiKey: options.openaiApiKey,
    openaiBaseUrl: options.openaiBaseUrl,
    xaiApiKey: options.xaiApiKey,
    xaiBaseUrl: options.xaiBaseUrl,
  });
  const openai = new OpenAI({ apiKey: transport.apiKey, baseURL: transport.baseUrl });
  const effort = clampReasoningEffort(options.preferences.model, options.preferences.reasoningEffort);
  const history = options.conversation
    .filter((item) => item.text.trim())
    .slice(-12)
    .map((item) => ({
      role: item.role,
      content: item.text,
    }));
  const input: OpenAI.Responses.ResponseInput = [
    ...history,
    { role: "user", content: options.message },
  ];
  const fy = financialYearToDateArgs();
  const missingReportScopes = organisation.missingReportScopes ?? [];
  const reconnectNote = missingReportScopes.length > 0
    ? `- This connection is still on an older Xero grant and is missing report scopes (${missingReportScopes.join(", ")}). If a report tool fails, tell the owner to reconnect Xero in Connections, then ask again. Do not invent a P&L from invoices.`
    : `- Prefer report tools for P&L, balance sheet, trial balance, and aged receivables or payables.`;
  const instructions = `You are Albert's Xero MCP test mode for ${organisation.displayName}.
You answer only questions about this live Xero organisation by calling the official Xero MCP tools.

Rules:
- If the question is not about Xero accounting, invoices, bills, contacts, bank, GST, payroll, quotes, or this organisation, refuse. Say this mode only answers Xero questions.
- Call tools before stating figures. Never invent balances, invoices, contacts, or dates.
- This Albert connection is read-only. Only list-* and get-* tools are available.
- list-invoices and similar paged tools require page. Start at page 1 and ask before paging further.
${reconnectNote}
- Today in Australia/Melbourne is ${melbourneToday()}. The current Australian financial year is ${fy.fromDate} to ${fy.toDate}. For P&L, YTD, or "our P&L" with no other period, call list-profit-and-loss with both fromDate and toDate set to that FY window. Never use a calendar year starting 1 January unless the owner asked for a calendar year. Never send fromDate without toDate. Never send a window longer than 12 months; Xero fails those with a generic communication error.
- If a report tool returns a Xero communication error, call it again with the current FY window, then with no dates. Do not stop after one failed report call.
- When the owner asks for a table, render a Markdown table of the P&L lines (account, amount). Name the period in the prose.
- Use Australian English. Treat amounts as AUD unless Xero says otherwise.
- Keep the owner-facing answer concise and specific to ${organisation.displayName}.`;

  let toolsUsed = 0;
  let lastOrganisation: XeroMcpOrganisation = organisation;
  let finalText = "";
  for (let round = 0; round < 10; round += 1) {
    options.signal?.throwIfAborted();
    const response = await openai.responses.create({
      model: options.preferences.model,
      instructions,
      input,
      tools: asFunctionTools(listed.tools),
      reasoning: effort === "none" ? undefined : { effort },
      store: false,
      service_tier: serviceTierForPreferences(options.preferences),
    }, { signal: options.signal });
    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length === 0) {
      finalText = outputText(response);
      break;
    }
    input.push(...response.output);
    for (const call of calls) {
      const args = (() => {
        try { return JSON.parse(call.arguments || "{}") as Record<string, unknown>; }
        catch { return {}; }
      })();
      const prepared = call.name === "list-profit-and-loss"
        ? normaliseProfitAndLossArgs(args).arguments
        : args;
      await options.emit({
        type: "progress",
        status: "running",
        stage: "query",
        label: sanitizeTraceText(`Xero MCP: ${toolLabel(call.name)}`, 160),
        detail: sanitizeTraceText(JSON.stringify(prepared), 220),
        progress: Math.min(0.85, 0.25 + toolsUsed * 0.08),
      });
      const output = await callOfficialTool(options.client, call.name, args, options.signal);
      lastOrganisation = output.organisation;
      toolsUsed += 1;
      await options.emit({
        type: "progress",
        status: output.isError ? "error" : "complete",
        stage: "query",
        label: sanitizeTraceText(
          output.isError ? `${toolLabel(call.name)} failed` : toolLabel(call.name),
          160,
        ),
        detail: sanitizeTraceText(output.text, 220),
      });
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: output.text,
      });
    }
  }

  const text = sanitizeAnswerText(
    finalText.trim()
      || "I could not retrieve that from the live Xero MCP. Try a more specific Xero question.",
  );
  const state: AnswerState = !finalText.trim()
    ? "Unavailable"
    : toolsUsed === 0
      ? "Qualified"
      : "Verified";
  await options.emit({
    type: "answer",
    status: "complete",
    state,
    text,
    provenance: provenance(lastOrganisation.displayName),
    followUps: [
      "What is our organisation name and base currency in Xero?",
      "Show the first page of invoices",
      "List the chart of accounts",
    ],
    presentedResultIds: [],
    claims: [],
  });
  return {
    answerState: state,
    answerText: text,
    organisationName: lastOrganisation.displayName,
    toolsUsed,
  };
}
