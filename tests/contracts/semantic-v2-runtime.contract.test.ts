import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseSemanticV2ToolInput,
  SEMANTIC_V2_TOOL_NAMES,
} from "../../packages/agent/src/semantic-v2-tools.js";
import {
  rebindCachedExecutionV2,
  type ExecutedWorkspaceV2,
} from "../../packages/analytics-v2/src/executor.js";
import {
  createSemanticHttpHandler,
  signSemanticHttpRequest,
} from "../../services/semantic-query/src/http.js";
import type { SemanticToolExecutor } from "../../services/semantic-query/src/types.js";
import { analyticalRuntimeRouteV2 } from "../../services/semantic-query/src/v2-runtime.js";
import {
  compileOperatorInput,
  type SemanticV2ToolExecutor,
} from "../../services/semantic-query/src/v2-service.js";
import {
  assertSemanticV2OpenAISchemaCompatibility,
  SEMANTIC_V2_MAX_TURNS,
} from "../../services/conversation/src/v2-live.js";

const v2Service = readFileSync(
  "services/semantic-query/src/v2-service.ts",
  "utf8",
);
const v2Live = readFileSync("services/conversation/src/v2-live.ts", "utf8");
const composition = readFileSync(
  "services/semantic-query/src/composition.ts",
  "utf8",
);
const nodeServer = readFileSync(
  "services/semantic-query/src/node-server.ts",
  "utf8",
);
const followUpWorkspaceBoundary = readFileSync(
  "infra/migrations/control-plane/0113_semantic_v2_followup_workspace_boundary.sql",
  "utf8",
);
const terminalEventTurnReadBoundary = readFileSync(
  "infra/migrations/control-plane/0114_semantic_v2_terminal_event_turn_read.sql",
  "utf8",
);

test("V2 tools expose only semantic workspaces, investigations, results, and governed operator bindings", () => {
  assert.deepEqual(SEMANTIC_V2_TOOL_NAMES, [
    "get_semantic_context_v2",
    "create_workspace_v2",
    "continue_workspace_v2",
    "apply_workspace_patch_v2",
    "validate_workspace_v2",
    "preview_workspace_v2",
    "execute_workspace_v2",
    "inspect_result_v2",
    "fork_query_block_v2",
    "create_investigation_v2",
    "get_investigation_v2",
    "update_investigation_v2",
    "run_analytical_operator_v2",
    "update_insight_v2",
  ]);
  assert.throws(
    () =>
      parseSemanticV2ToolInput("get_semantic_context_v2", {
        question: "sales",
        sql: "select 1",
      }),
    /cannot contain/iu,
  );
  assert.throws(
    () =>
      parseSemanticV2ToolInput("create_workspace_v2", {
        blocks: [],
        physicalTable: "mart.sales",
      }),
    /cannot contain/iu,
  );
  assert.throws(
    () =>
      parseSemanticV2ToolInput("run_analytical_operator_v2", {
        operatorId: "period_contribution",
        values: [1, 2],
      }),
    /invalid|unrecognized|expected/iu,
  );
  assert.doesNotThrow(() =>
    parseSemanticV2ToolInput("run_analytical_operator_v2", {
      operatorId: "period_contribution",
      bindings: [
        {
          role: "current",
          executionId: "execution",
          resultId: "result",
          columns: { value: "commerce.net_sales" },
        },
      ],
      parameters: {},
    }),
  );
  assert.throws(
    () =>
      parseSemanticV2ToolInput("run_analytical_operator_v2", {
        operatorId: "pos_xero_reconciliation",
        bindings: [
          {
            role: "primary",
            executionId: "execution",
            resultId: "result",
            columns: { posRevenue: "pos", xeroRevenue: "xero" },
          },
        ],
        parameters: { tolerance: 1 },
      }),
    /unrecognized|invalid/iu,
  );
  assert.doesNotThrow(() =>
    parseSemanticV2ToolInput("update_investigation_v2", {
      investigationId: "investigation",
      expectedRevision: 1,
      operations: [
        {
          op: "set_evidence_status",
          evidenceNodeId: "node",
          status: "succeeded",
          resultRefs: [{ executionId: "execution", resultId: "result" }],
        },
      ],
    }),
  );
  assert.doesNotThrow(() =>
    parseSemanticV2ToolInput("update_insight_v2", {
      insightKey: "a".repeat(64),
      expectedState: "active",
      state: "accepted",
      associatedAction: "Review the reorder policy next Monday.",
    }),
  );
  assert.deepEqual(
    parseSemanticV2ToolInput("create_workspace_v2", {
      blocks: [
        {
          id: "sales",
          topicIds: ["business.sales_performance"],
          rootViewId: "lightspeed.sales",
          dimensionIds: null,
          measureIds: ["lightspeed.net_sales"],
          filters: null,
          time: { range: { type: "current_snapshot" } },
          comparison: null,
          sort: null,
          limit: null,
          parameters: null,
        },
      ],
    }).blocks[0],
    {
      id: "sales",
      topicIds: ["business.sales_performance"],
      rootViewId: "lightspeed.sales",
      dimensionIds: [],
      measureIds: ["lightspeed.net_sales"],
      filters: [],
      time: { range: { type: "current_snapshot" } },
      sort: [],
      limit: 100,
      parameters: {},
    },
  );
  assert.deepEqual(
    parseSemanticV2ToolInput("apply_workspace_patch_v2", {
      workspaceId: "workspace",
      patch: {
        expectedRevision: 1,
        operations: [
          { op: "set_comparison", blockId: "sales", comparison: null },
        ],
      },
    }).patch.operations[0],
    { op: "set_comparison", blockId: "sales", comparison: null },
  );
});

test("every V2 model tool and final output compiles to an OpenAI strict schema", () => {
  assert.doesNotThrow(() => assertSemanticV2OpenAISchemaCompatibility());
});

test("V2 orchestration can use the 800-second Luna Max evaluation window", () => {
  assert.equal(SEMANTIC_V2_MAX_TURNS, 64);
  assert.match(v2Live, /maxTurns: SEMANTIC_V2_MAX_TURNS/u);
});

test("workspace and investigation evidence mutations are scoped to the current turn", () => {
  assert.match(v2Service, /workspace\.questionId !== context\.turnId/u);
  assert.match(
    v2Service,
    /this\.assertCurrentTurnWorkspace\(workspace, context\)/u,
  );
  assert.match(
    v2Service,
    /e\.execution_id\|\|':'\|\|\(e\.artifact->>'queryId'\)/u,
  );
  assert.match(v2Service, /OPERATOR_EVIDENCE_NOT_FOUND/u);
  assert.match(v2Service, /OPERATOR_EVIDENCE_MISMATCH/u);
  assert.match(v2Service, /artifact->>'operatorId' AS operator_id/u);
});

test("follow-up workspace discovery uses a lease-bound projection instead of conversation-ledger table access", () => {
  assert.match(v2Service, /load_previous_semantic_workspace_v2/u);
  assert.doesNotMatch(
    v2Service,
    /SELECT w\.workspace_id,w\.publication_hash,w\.overlay_version/u,
  );
  assert.match(
    followUpWorkspaceBoundary,
    /require_exact_runtime_login\([\s\S]*'albert_semantic_control_runtime'[\s\S]*'albert_semantic_control'/u,
  );
  assert.match(
    followUpWorkspaceBoundary,
    /current_turn\.status='running'[\s\S]*lease_expires_at>clock_timestamp\(\)/u,
  );
  assert.match(
    followUpWorkspaceBoundary,
    /GRANT EXECUTE ON FUNCTION control_plane\.load_previous_semantic_workspace_v2\(text,text,text\)[\s\S]*TO albert_semantic_control/u,
  );
  assert.doesNotMatch(
    followUpWorkspaceBoundary,
    /GRANT (?:SELECT|ALL)[^;]*conversation_turns/iu,
  );
});

test("terminal-state telemetry can read only the current tenant's conversation turn", () => {
  assert.match(
    terminalEventTurnReadBoundary,
    /GRANT SELECT ON TABLE control_plane\.conversation_turns\s+TO albert_semantic_control/u,
  );
  assert.match(
    terminalEventTurnReadBoundary,
    /FOR SELECT\s+TO albert_semantic_control\s+USING \(tenant_id = current_setting\('albert\.tenant_id', true\)\)/u,
  );
  assert.doesNotMatch(
    terminalEventTurnReadBoundary,
    /GRANT (?:INSERT|UPDATE|DELETE|ALL)[^;]*conversation_turns/iu,
  );
});

test("open-ended V2 answers suppress unchanged insight-ledger findings in trusted code", () => {
  assert.match(v2Service, /evidence_digest/u);
  assert.match(v2Live, /unchangedInsightClaimIdsV2/u);
  assert.match(v2Live, /did not produce a materially new insight/u);
  assert.match(v2Live, /Previously surfaced findings were unchanged/u);
});

test("trusted operator binding preserves continuing, new, and discontinued items", () => {
  const overlay = {
    overlayHash: "a".repeat(64),
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "04:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    defaults: {},
    dossier: {},
    authorityByConcept: {},
    businessContextValues: [],
  };
  const bindings = [
    {
      role: "current" as const,
      executionId: "current-execution",
      resultId: "current-result",
      columns: { key: "sku", price: "price", volume: "units" },
      rows: [
        { sku: "a", price: "11", units: "15" },
        { sku: "b", price: "8", units: "4" },
      ],
      publicationHash: "b".repeat(64),
    },
    {
      role: "comparison" as const,
      executionId: "prior-execution",
      resultId: "prior-result",
      columns: { key: "sku", price: "price", volume: "units" },
      rows: [
        { sku: "a", price: "10", units: "10" },
        { sku: "c", price: "5", units: "2" },
      ],
      publicationHash: "b".repeat(64),
    },
  ];
  const input = compileOperatorInput("price_volume_mix", bindings, overlay);
  assert.equal(input.operatorId, "price_volume_mix");
  if (input.operatorId !== "price_volume_mix")
    throw new Error("Expected price-volume-mix input.");
  assert.deepEqual(
    input.items.map(({ key, population, currentVolume, comparisonVolume }) => ({
      key,
      population,
      currentVolume,
      comparisonVolume,
    })),
    [
      {
        key: "a",
        population: "continuing",
        currentVolume: "15",
        comparisonVolume: "10",
      },
      {
        key: "b",
        population: "new",
        currentVolume: "4",
        comparisonVolume: "0",
      },
      {
        key: "c",
        population: "discontinued",
        currentVolume: "0",
        comparisonVolume: "2",
      },
    ],
  );
});

test("the server analytical route defaults to V1 and accepts only an explicit V2 switch", () => {
  assert.equal(analyticalRuntimeRouteV2({}), "v1");
  assert.equal(
    analyticalRuntimeRouteV2({ ALBERT_ANALYTICAL_RUNTIME: "v2" }),
    "v2",
  );
  assert.throws(
    () => analyticalRuntimeRouteV2({ ALBERT_ANALYTICAL_RUNTIME: "canary" }),
    /must be v1 or v2/iu,
  );
});

test("the signed HTTP boundary routes V2 tool names containing their version suffix", async () => {
  const secret = "semantic-v2-http-contract-secret-at-least-32-bytes";
  const now = Date.parse("2026-08-10T00:00:00.000Z");
  const path = "/v2/tools/get_semantic_context_v2";
  const body = JSON.stringify({
    tenantId: "01KZN20VTX2EWW1TQ2AA3MCPW6",
    conversationId: "01KZN20VTX2EWW1TQ2AA3MCPW7",
    turnId: "01KZN20VTX2EWW1TQ2AA3MCPW8",
    role: "owner",
    input: { question: "What were sales?", limit: 1 },
  });
  let invoked = false;
  const v1Executor: SemanticToolExecutor = {
    async execute() {
      throw new Error("V1 tool route was not expected.");
    },
  };
  const v2Executor: SemanticV2ToolExecutor = {
    async execute(name) {
      invoked = true;
      assert.equal(name, "get_semantic_context_v2");
      return { publicationHash: "a".repeat(64) };
    },
  };
  const handler = createSemanticHttpHandler(v1Executor, {
    hmacSecret: secret,
    clock: () => now,
    analyticalRuntime: "v2",
    v2Executor,
  });
  const headers = await signSemanticHttpRequest(path, body, secret, now);
  const response = await handler(
    new Request(`http://semantic.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(invoked, true);
  assert.deepEqual(await response.json(), {
    result: { publicationHash: "a".repeat(64) },
  });
});

test("V2 readiness verifies its pinned publication without depending on the V1 catalogue", () => {
  assert.match(composition, /loadSemanticRegistryV2/u);
  assert.match(composition, /semanticV2Publication/u);
  assert.match(composition, /options\.analyticalRuntime==="v2"/u);
  assert.match(
    composition,
    /\{controlPlane,analyticalRead,semanticMetadata,semanticV2Publication/u,
  );
  assert.match(nodeServer, /checks:readiness\.checks/u);
});

test("a cache hit gets new immutable lineage and never inherits answer claims", () => {
  const source: ExecutedWorkspaceV2 = {
    executionId: "01K30000000000000000000001",
    normalizedPlanHash: "a".repeat(64),
    terminalState: "verified",
    queries: [
      {
        queryId: "sales.current",
        period: "current",
        topicIds: ["business.sales_performance"],
        dimensionIds: [],
        measureIds: ["commerce.net_sales"],
        resultColumns: ["commerce.net_sales"],
        timeRange: {
          label: "July",
          start: "2026-07-01T00:00:00.000Z",
          end: "2026-08-01T00:00:00.000Z",
          timezone: "Australia/Melbourne",
        },
        rows: [{ "commerce.net_sales": 100 }],
        durationMs: 4,
        explainCost: 2,
        resultDigest: "b".repeat(64),
        evidence: {
          executionId: "01K30000000000000000000001",
          resultId: "sales.current",
          state: "verified",
          rowCount: 1,
          validationPassed: true,
          publicationHash: "c".repeat(64),
          limitations: [],
        },
      },
    ],
    blocks: [
      {
        blockId: "sales",
        currentRows: [{ "commerce.net_sales": 100 }],
        comparisonRows: [],
        dimensionIds: [],
        state: "verified",
      },
    ],
    claims: [
      {
        id: "old-claim",
        text: "Old answer claim",
        type: "numeric",
        evidenceRefs: [
          {
            executionId: "01K30000000000000000000001",
            resultId: "sales.current",
            rowIndex: 0,
            columnKey: "commerce.net_sales",
            publicationHash: "c".repeat(64),
          },
        ],
        semanticState: "verified",
        limitations: [],
        competingHypothesisRefs: [],
      },
    ],
    resultDigest: "d".repeat(64),
    sourceWatermarks: { lightspeed: "1" },
    validation: {
      passed: true,
      explainCostPassed: true,
      tenantIsolationPassed: true,
      fanoutSafetyPassed: true,
      evidenceComplete: true,
      cacheHit: false,
    },
  };
  const rebound = rebindCachedExecutionV2(source, "01K30000000000000000000002");
  assert.equal(rebound.executionId, "01K30000000000000000000002");
  assert.equal(
    rebound.queries[0]?.evidence.executionId,
    "01K30000000000000000000002",
  );
  assert.equal(rebound.validation.cacheHit, true);
  assert.deepEqual(rebound.claims, []);
  assert.equal(rebound.resultDigest, source.resultDigest);
});
