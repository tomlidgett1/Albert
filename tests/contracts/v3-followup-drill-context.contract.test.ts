/**
 * Follow-ups drill into what the owner is looking at, and an unpopulated
 * connector is named as such instead of probed to death.
 *
 * Origin: turn 01M095JN49M4NQ4PZBD9FJ9QGN (2026-08-18). After a live Xero P&L
 * showing "Subscriptions 3,739.08", the owner asked "what subscriptions do we
 * have?". The follow-up saw only the prose and the tool JSON of the previous
 * answer, not the statement's rows, so it planned a generic "find recurring
 * subscriptions" investigation; every governed Xero view was empty (the Fivetran
 * union views were stubs, fixed by analytical migration 0172), and after seven
 * empty queries the answer blamed "this connection".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.ts";
import type { CubeCatalogue, CubeLoadResponse } from "../../packages/albert-v3/src/cube/types.ts";
import type { ValidatedCubeQuery } from "../../packages/albert-v3/src/cube/client.ts";
import { createV3CommentaryState } from "../../packages/albert-v3/src/engine/commentary.ts";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.ts";
import type { V3TurnContext } from "../../packages/albert-v3/src/engine/context.ts";
import { buildPresentedTableDigest } from "../../packages/albert-v3/src/engine/engine.ts";
import { PRESENTED_TABLE_DRILL_DOCTRINE } from "../../packages/albert-v3/src/engine/lanes.ts";
import {
  buildConversationInput,
  classifierInstructions,
  coerceRefinementIntent,
  renderPresentedTables,
  type ConversationMessage,
} from "../../packages/albert-v3/src/engine/orchestrator.ts";
import {
  connectorLooksUnpopulated,
  executeGovernedCubeQuery,
  isUnconstrainedCubeQuery,
} from "../../packages/albert-v3/src/engine/tools.ts";
import {
  loadConversationModelContext,
  type ConversationSupabase,
} from "../../services/conversation/src/artifact-store.ts";

const config = loadAgentConfig();
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const PNL_ROWS = [
  { section: "Income", line: "Sales", period_1: 541572.98 },
  { section: "Less Operating Expenses", line: "Rent", period_1: 45344.52 },
  { section: "Less Operating Expenses", line: "Subscriptions", period_1: 3739.08 },
  { section: "", line: "Net Profit", period_1: -6871.65 },
];

const pnlTable = {
  resultId: "01RESULTPNL000000000000000",
  caption: "Profit and Loss — Ashburton Cycles — 2025-08-19 to 2026-08-18",
  columns: [
    { key: "section", label: "Section" },
    { key: "line", label: "Line" },
    { key: "period_1", label: "18 Aug 26" },
  ],
  rows: PNL_ROWS,
};

test("the answer event carries a bounded digest of the tables the owner saw", () => {
  const wide = {
    resultId: "01RESULTWIDE00000000000000",
    caption: "Every ledger line",
    columns: Array.from({ length: 12 }, (_, index) => ({ key: `c${index}`, label: `Column ${index}` })),
    rows: Array.from({ length: 2_000 }, (_, row) => Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`c${index}`, `${"x".repeat(200)}${row}`]),
    )),
  };
  const digest = buildPresentedTableDigest([pnlTable, wide], [pnlTable.resultId, wide.resultId]);
  assert.equal(digest.length, 2);
  // The statement travels whole: every line, exact values.
  assert.deepEqual(digest[0]?.columns, ["Section", "Line", "18 Aug 26"]);
  assert.equal(digest[0]?.rowCount, 4);
  assert.deepEqual(digest[0]?.rows[2], ["Less Operating Expenses", "Subscriptions", 3739.08]);
  // A huge table is clipped on every axis but keeps its true row count.
  assert.equal(digest[1]?.rowCount, 2_000);
  assert.ok((digest[1]?.rows.length ?? 0) <= 60);
  assert.equal(digest[1]?.columns.length, 8);
  assert.ok(String(digest[1]?.rows[0]?.[0]).length <= 80);
  assert.ok(JSON.stringify(digest).length <= 12_000, "the whole digest stays under the persisted-event budget");
  // Unknown result ids are ignored, never invented.
  assert.deepEqual(buildPresentedTableDigest([pnlTable], ["01MISSING00000000000000000"]), []);
});

test("model context restores presented tables from the persisted answer event", async () => {
  const supabase = {
    rpc: async (name: string) => {
      assert.equal(name, "albert_model_context");
      return {
        error: null,
        data: [{
          turn_number: 1,
          user_message: "show me the P&L",
          status: "completed",
          assistant_event: {
            type: "answer",
            text: "Here is your Profit and Loss for the year to 18 August 2026.",
            provenance: { definitions: [{
              metric: "cube.yaml:xero-mcp:profit_and_loss",
              label: "Fetching the Profit and Loss from Xero",
              definition: "{\"tool\":\"list-profit-and-loss\"}",
            }] },
            presentedTables: [{
              caption: pnlTable.caption,
              columns: ["Section", "Line", "18 Aug 26"],
              rowCount: 4,
              rows: PNL_ROWS.map((row) => [row.section, row.line, row.period_1]),
            }],
          },
        }],
      };
    },
  } as unknown as ConversationSupabase;
  const messages = await loadConversationModelContext("conversation_test", supabase);
  assert.equal(messages[1]?.presentedTables?.length, 1);
  assert.deepEqual(messages[1]?.presentedTables?.[0]?.rows[2], ["Less Operating Expenses", "Subscriptions", 3739.08]);
  assert.deepEqual(messages[1]?.governedQueries?.map(({ view }) => view), ["xero-mcp:profit_and_loss"]);
});

test("a malformed presentedTables payload degrades to none rather than failing the turn", async () => {
  const supabase = {
    rpc: async () => ({
      error: null,
      data: [{
        turn_number: 1,
        user_message: "hi",
        status: "completed",
        assistant_event: { type: "answer", text: "Hello.", presentedTables: "not a table list" },
      }],
    }),
  } as unknown as ConversationSupabase;
  const messages = await loadConversationModelContext("conversation_test", supabase);
  assert.equal(messages[1]?.presentedTables, undefined);
});

test("the follow-up turn sees the statement rows and is told a named line is a drill", () => {
  const conversation: ConversationMessage[] = [
    { role: "user", text: "show me the P&L" },
    {
      role: "assistant",
      text: "Here is your Profit and Loss.",
      governedQueries: [{ view: "xero-mcp:profit_and_loss", topic: "P&L", queryYaml: "{\"tool\":\"list-profit-and-loss\"}" }],
      presentedTables: [{
        caption: pnlTable.caption,
        columns: ["Section", "Line", "18 Aug 26"],
        rowCount: 4,
        rows: PNL_ROWS.map((row) => [row.section, row.line, row.period_1]),
      }],
    },
    { role: "user", text: "what subscritons do we have?" },
  ];
  const items = buildConversationInput(conversation, "what subscritons do we have?");
  const assistantItem = items.find((item) => "role" in item && item.role === "assistant");
  const rendered = JSON.stringify(assistantItem);
  assert.match(rendered, /Table shown: Profit and Loss — Ashburton Cycles/u);
  assert.match(rendered, /Less Operating Expenses \| Subscriptions \| 3739\.08/u);
  assert.match(rendered, /refers to THAT entry/u);
  assert.match(rendered, /xero-mcp: are live Xero statement tools that cannot be filtered or drilled/u);

  const rows = renderPresentedTables(conversation[1]!.presentedTables!);
  assert.match(rows, /\(4 rows\)/u);
  assert.doesNotMatch(rows, /first \d+ listed/u);

  // The intent orchestrator is told what a named statement line means.
  const instructions = classifierInstructions(config, [], ["xero"]);
  assert.match(instructions, /DRILL into that entry, not a new topic/u);
  assert.match(instructions, /pnl_\* members filtered by account name/u);
  assert.match(instructions, /live statement\s+tools cannot filter or drill and must not be re-run/u);

  // Both data lanes carry the drill doctrine and it names the ledger path.
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  assert.equal(lanes.match(/\$\{PRESENTED_TABLE_DRILL_DOCTRINE\}/gu)?.length, 2);
  assert.match(PRESENTED_TABLE_DRILL_DOCTRINE, /pnl_\* members with a filter\s+on the account name/u);
  assert.match(PRESENTED_TABLE_DRILL_DOCTRINE, /must reconcile to the\s+statement line/u);
  assert.match(PRESENTED_TABLE_DRILL_DOCTRINE, /Do not re-fetch the statement itself/u);

  // A prior answer that only showed a table (no governed Cube query) still
  // anchors a refinement instead of falling to clarification.
  const decision = coerceRefinementIntent({
    lane: "clarification",
    resolvedQuestion: "?",
    ownerGoal: null,
    answerShape: "fact",
    answerMustCover: [],
    assumptions: [],
    clarificationQuestion: "Which subscriptions?",
    clarificationOptions: ["a", "b"],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
  }, conversation, "add rent too");
  assert.notEqual(decision.lane, "clarification");
});

// ---- Unpopulated connector guard -------------------------------------------------

const VIEW = "xero_finance_analytics";
const catalogue: CubeCatalogue = {
  fetchedAt: "2026-08-18T00:00:00.000Z",
  views: [{
    name: VIEW,
    title: "Finance analytics (Xero)",
    members: [
      { name: `${VIEW}.invoice_count`, kind: "measure", title: "Documents", shortTitle: "Documents", type: "number", aliasMember: "xero_invoices.invoice_count" },
      { name: `${VIEW}.issued_on`, kind: "dimension", title: "Issue date", shortTitle: "Issued", type: "time", aliasMember: "xero_invoices.issued_on" },
      { name: `${VIEW}.recurring_template_count`, kind: "measure", title: "Templates", shortTitle: "Templates", type: "number", aliasMember: "xero_repeating_invoices.recurring_template_count" },
      { name: `${VIEW}.pnl_expenses`, kind: "measure", title: "Expenses", shortTitle: "Expenses", type: "number", aliasMember: "xero_pnl_lines.pnl_expenses" },
      { name: `${VIEW}.pnl_account`, kind: "dimension", title: "Account", shortTitle: "Account", type: "string", aliasMember: "xero_pnl_lines.pnl_account" },
    ],
  }],
};

function route(): V3ToolRoute {
  return {
    cube: true,
    shopifyQL: false,
    shopifyAdmin: false,
    activeCubeConnectors: ["xero"],
    preferredCubeConnectors: ["xero"],
    unavailableRequestedConnectors: [],
    mode: "cube",
    reasons: [],
  };
}

function emptyXeroContext(seen: unknown[], events: unknown[]): V3TurnContext {
  const cubeOf = (query: { measures?: readonly string[] }): string =>
    catalogue.views[0]!.members.find((member) => member.name === query.measures?.[0])!.aliasMember!.split(".")[0]!;
  return {
    cube: {
      fetchCatalogue: async () => catalogue,
      loadQuery: async (query: { measures?: readonly string[] }) => {
        seen.push(query);
        const validated: ValidatedCubeQuery = {
          query: query as ValidatedCubeQuery["query"],
          view: VIEW,
          cubes: [cubeOf(query)],
          members: [...(query.measures ?? [])],
        };
        const result: CubeLoadResponse = { ok: true, rows: [], annotation: {}, executionMs: 3, cached: false };
        return { validated, result };
      },
    } as unknown as V3TurnContext["cube"],
    config,
    promptCachePartition: "fixturetenant",
    toolRoute: route(),
    emit: async (event) => {
      events.push(event);
      return { ...event, id: "01K2K2A6S9W9M4FW4NG4TDD9E1", sequence: events.length, occurredAt: "2026-08-18T00:00:00.000Z" } as never;
    },
    budget: { maxQueries: 8, executed: 0 },
    connectorFreshness: [],
    sourceFindings: [],
    commentary: createV3CommentaryState(false),
    executedQueries: [],
    tableResults: new Map(),
    priorResults: new Map(),
    chartedResultIds: new Set(),
  };
}

test("isUnconstrainedCubeQuery recognises whole-table reads", () => {
  assert.equal(isUnconstrainedCubeQuery({ measures: ["a.b"] }), true);
  assert.equal(isUnconstrainedCubeQuery({ measures: ["a.b"], timeDimensions: [{ dimension: "a.t", granularity: "month" }] }), true);
  assert.equal(isUnconstrainedCubeQuery({ measures: ["a.b"], timeDimensions: [{ dimension: "a.t", dateRange: "last 30 days" }] }), false);
  assert.equal(isUnconstrainedCubeQuery({ measures: ["a.b"], segments: ["a.s"] }), false);
  assert.equal(isUnconstrainedCubeQuery({ measures: ["a.b"], filters: [{ member: "a.c", operator: "equals", values: ["x"] }] }), false);
});

test("two whole-table empties mark the connector unpopulated; a proven-empty cube is not re-run", async () => {
  const seen: unknown[] = [];
  const events: Record<string, unknown>[] = [];
  const context = emptyXeroContext(seen, events as unknown[]);

  const first = await executeGovernedCubeQuery(context, {
    topic: "All repeating templates",
    measures: [`${VIEW}.recurring_template_count`],
  });
  assert.equal(first.ok, true);
  assert.equal(first.rowCount, 0);
  assert.equal(first.unpopulatedConnector, undefined, "one empty cube is not yet a verdict");
  assert.equal(connectorLooksUnpopulated(context, "xero"), false);

  // Date-only constraint whose relaxed probe is also empty counts as whole-table empty.
  const second = await executeGovernedCubeQuery(context, {
    topic: "Bills last year",
    measures: [`${VIEW}.invoice_count`],
    timeDimensions: [{ dimension: `${VIEW}.issued_on`, dateRange: "2025-08-19,2026-08-18" }],
  });
  assert.equal(second.ok, true);
  const verdict = second.unpopulatedConnector as Record<string, unknown> | undefined;
  assert.ok(verdict, "the second empty cube must carry the unpopulated-connector verdict");
  assert.equal(verdict.connector, "xero");
  assert.match(String(verdict.note), /has not ingested their xero data yet/u);
  assert.match(String(verdict.note), /Never phrase this as the detail being "not available through this connection"/u);
  assert.equal(connectorLooksUnpopulated(context, "xero"), true);
  assert.ok(events.some((event) => String(event.label).startsWith("No xero data has been ingested into Albert yet")));

  // Re-querying a proven-empty cube is refused before Cube is touched.
  const loadsBefore = seen.length;
  const budgetBefore = context.budget.executed;
  const third = await executeGovernedCubeQuery(context, {
    topic: "Bills by status",
    measures: [`${VIEW}.invoice_count`],
  });
  assert.equal(third.ok, false);
  assert.match(String(third.error), /already returned zero rows/u);
  assert.match(String(third.guidance), /has not ingested their xero data yet/u);
  assert.equal(seen.length, loadsBefore, "no Cube round-trip for a proven-empty cube");
  assert.equal(context.budget.executed, budgetBefore, "and no budget spent");

  // A cube not yet probed may still run (payroll may have landed when invoices
  // have not), but its empty result now carries the verdict too.
  const fourth = await executeGovernedCubeQuery(context, {
    topic: "Expense lines",
    measures: [`${VIEW}.pnl_expenses`],
    dimensions: [`${VIEW}.pnl_account`],
  });
  assert.equal(fourth.ok, true);
  assert.ok(fourth.unpopulatedConnector);
});

test("a filtered empty result is never treated as whole-table emptiness", async () => {
  const seen: unknown[] = [];
  const events: unknown[] = [];
  const context = emptyXeroContext(seen, events);
  const output = await executeGovernedCubeQuery(context, {
    topic: "Subscriptions lines",
    measures: [`${VIEW}.pnl_expenses`],
    filters: [{ member: `${VIEW}.pnl_account`, operator: "equals", values: ["Subscriptions"] }],
  });
  assert.equal(output.ok, true);
  assert.equal(context.unpopulatedCubes?.get("xero")?.size ?? 0, 0);
});

test("0172 makes the Fivetran union rebuild survive landed-shape changes and re-runs it", () => {
  const migration = read("infra/migrations/analytical/0172_m2_fivetran_union_views_survive_shape_changes.sql");
  assert.match(migration, /CREATE OR REPLACE FUNCTION ingestion\.recreate_view_with_dependents/u);
  assert.match(migration, /DROP VIEW %I\.%I CASCADE/u);
  assert.match(migration, /WHEN feature_not_supported OR invalid_table_definition OR datatype_mismatch OR undefined_column THEN\s+PERFORM ingestion\.recreate_view_with_dependents/u);
  // The swallow-and-stub path is gone: the union loop no longer catches errors silently.
  assert.doesNotMatch(migration, /dependent_objects_still_exist THEN\s+NULL;/u);
  assert.match(migration, /SELECT ingestion\.rebuild_fivetran_source_views\('xero'\);/u);
  assert.match(migration, /SELECT ingestion\.rebuild_fivetran_source_views\('deputy'\);/u);
  assert.match(migration, /union views still stubbed despite landed tables/u);
});
