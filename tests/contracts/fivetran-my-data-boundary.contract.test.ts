import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresOperatorDiagnosticReadStore,
  type DiagnosticPgClient,
  type DiagnosticPgPool,
} from "../../services/operator-diagnostic/src/database.js";
import {
  fivetranMyDataGrantSchema,
  fivetranMyDataResultSchema,
  type FivetranMyDataGrant,
  type FivetranMyDataResult,
} from "../../services/operator-diagnostic/src/contracts.js";
import {
  createOperatorDiagnosticHttpHandler,
  FIVETRAN_MY_DATA_PATH,
  signFivetranMyDataRequest,
  type OperatorDiagnosticControlStore,
  type OperatorDiagnosticReadStore,
} from "../../services/operator-diagnostic/src/http.js";

const requestId = "01K1ZZZZZZ0000000000000300";
const tenantId = "01K1ZZZZZZ0000000000000301";
const connectionId = "01K1ZZZZZZ0000000000000302";
const foreignConnectionId = "01K1ZZZZZZ0000000000000303";
const schemaName = `xero_${connectionId.toLowerCase()}`;
const tableName = "xero_invoices";
const now = 1_800_000_000_000;
const secret = "fivetran-my-data-test-secret-that-is-more-than-32-bytes";
const analyticalCapability = JSON.stringify({
  payload: { nonce: "01K1ZZZZZZ0000000000000304" },
  signature: "a".repeat(64),
  padding: "x".repeat(100),
});

const rowsGrant: FivetranMyDataGrant = {
  request_id: requestId,
  tenant_id: tenantId,
  request_kind: "rows",
  schema_name: schemaName,
  table_name: tableName,
  row_offset: 25,
  row_limit: 2,
  sources: [{
    connection_id: connectionId,
    destination_schema: schemaName,
    service: "xero",
    display_name: "Albert Bike Store",
    status: "connected",
    last_sync_state: "succeeded",
    updated_at: "2026-08-19T01:00:00.000Z",
  }],
  expires_at: "2030-01-01T00:00:00.000Z",
  analytical_capability: analyticalCapability,
};

const catalogueGrant: FivetranMyDataGrant = {
  ...rowsGrant,
  request_kind: "catalogue",
  schema_name: null,
  table_name: null,
  row_offset: 0,
  row_limit: 25,
};

function rowsResult(): FivetranMyDataResult {
  return {
    kind: "rows",
    table: {
      requestId,
      schemaName,
      tableName,
      columns: [
        { name: "id", dataType: "text" },
        { name: "amount", dataType: "numeric" },
      ],
      rows: [
        { id: "invoice-26", amount: "110.00" },
        { id: "invoice-27", amount: null },
      ],
      offset: 25,
      limit: 2,
      hasMore: true,
      approximateRows: 130,
      excludedColumnCount: 3,
      additionalColumnCount: 0,
      cellCharacterLimit: 500,
    },
  };
}

function unusedControlMethods(): Pick<OperatorDiagnosticControlStore, "claim" | "complete"> {
  return {
    async claim() { throw new Error("legacy diagnostic claim must not run"); },
    async complete() { throw new Error("legacy diagnostic completion must not run"); },
  };
}

function unusedReadMethods(): Pick<OperatorDiagnosticReadStore, "sample"> {
  return {
    async sample() { throw new Error("legacy diagnostic sample must not run"); },
  };
}

async function signedRequest(): Promise<Request> {
  const body = JSON.stringify({ requestId });
  const headers = await signFivetranMyDataRequest(body, secret, now);
  return new Request(`https://diagnostic.example${FIVETRAN_MY_DATA_PATH}`, {
    method: "POST",
    headers,
    body,
  });
}

test("the signed request is consumed once and completion is durable before rows return", async () => {
  const calls: string[] = [];
  let claimCount = 0;
  let markCompletionStarted!: () => void;
  let releaseCompletion!: () => void;
  const completionStarted = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const handler = createOperatorDiagnosticHttpHandler({
    signingSecret: secret,
    clock: () => now,
    controlStore: {
      ...unusedControlMethods(),
      async claimFivetranMyData(id) {
        calls.push(`claim:${id}`);
        claimCount += 1;
        if (claimCount > 1) {
          throw Object.assign(new Error("already consumed"), {
            diagnosticCode: "FIVETRAN_MY_DATA_ALREADY_CONSUMED",
          });
        }
        return rowsGrant;
      },
      async completeFivetranMyData(input) {
        calls.push(`complete:${input.status}:${input.resultCount}`);
        markCompletionStarted();
        await completionGate;
      },
    },
    readStore: {
      ...unusedReadMethods(),
      async browseFivetranMyData(grant) {
        calls.push(`read:${grant.schema_name}.${grant.table_name}`);
        return rowsResult();
      },
    },
  });

  let responseSettled = false;
  const responsePromise = handler(await signedRequest()).then((response) => {
    responseSettled = true;
    return response;
  });
  await completionStarted;
  await Promise.resolve();
  assert.equal(responseSettled, false, "rows escaped before the terminal outcome was persisted");
  assert.deepEqual(calls, [
    `claim:${requestId}`,
    `read:${schemaName}.${tableName}`,
    "complete:completed:2",
  ]);

  releaseCompletion();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { result: rowsResult() });

  const replay = await handler(await signedRequest());
  assert.equal(replay.status, 503);
  assert.equal(calls.filter((call) => call.startsWith("read:")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("complete:")).length, 1);
});

test("read and completed-outcome failures are terminally recorded before data is discarded", async (context) => {
  await context.test("a read failure records the safe code", async () => {
    const completions: unknown[] = [];
    const handler = createOperatorDiagnosticHttpHandler({
      signingSecret: secret,
      clock: () => now,
      controlStore: {
        ...unusedControlMethods(),
        async claimFivetranMyData() { return rowsGrant; },
        async completeFivetranMyData(input) { completions.push(input); },
      },
      readStore: {
        ...unusedReadMethods(),
        async browseFivetranMyData() {
          throw Object.assign(new Error("customer values must not leak"), {
            diagnosticCode: "FIVETRAN_ROW_READ_FAILED",
          });
        },
      },
    });

    const response = await handler(await signedRequest());
    assert.equal(response.status, 503);
    assert.deepEqual(completions, [{
      requestId,
      status: "failed",
      resultCount: 0,
      errorCode: "FIVETRAN_ROW_READ_FAILED",
    }]);
    assert.doesNotMatch(await response.text(), /customer values must not leak/u);
  });

  await context.test("a completed-outcome failure replaces the response with a failed outcome", async () => {
    const statuses: string[] = [];
    const handler = createOperatorDiagnosticHttpHandler({
      signingSecret: secret,
      clock: () => now,
      controlStore: {
        ...unusedControlMethods(),
        async claimFivetranMyData() { return rowsGrant; },
        async completeFivetranMyData(input) {
          statuses.push(input.status);
          if (input.status === "completed") {
            throw Object.assign(new Error("completion unavailable"), {
              diagnosticCode: "FIVETRAN_COMPLETION_FAILED",
            });
          }
        },
      },
      readStore: {
        ...unusedReadMethods(),
        async browseFivetranMyData() { return rowsResult(); },
      },
    });

    const response = await handler(await signedRequest());
    assert.equal(response.status, 503);
    assert.deepEqual(statuses, ["completed", "failed"]);
    assert.doesNotMatch(await response.text(), /invoice-26|110\.00/u);
  });
});

type Statement = Readonly<{ sql: string; parameters?: readonly unknown[] }>;

function fakeReadClient(options: Readonly<{
  bindingRows?: readonly Readonly<Record<string, unknown>>[];
  targetRows?: readonly Readonly<Record<string, unknown>>[];
  metadataRows?: readonly Readonly<Record<string, unknown>>[];
  primaryKeyRows?: readonly Readonly<Record<string, unknown>>[];
  pageRows?: readonly Readonly<Record<string, unknown>>[];
  catalogueRows?: readonly Readonly<Record<string, unknown>>[];
}> = {}): Readonly<{ client: DiagnosticPgClient; statements: Statement[] }> {
  const statements: Statement[] = [];
  const client: DiagnosticPgClient = {
    async query(sql, parameters) {
      statements.push({ sql, parameters });
      if (sql.includes("session_user='albert_operator_diagnostic_analytical_runtime'")) {
        return { rows: [{ ready: true }] };
      }
      if (sql.includes("FROM ingestion.fivetran_destination_bindings")) {
        return {
          rows: options.bindingRows ?? [{
            destination_schema: schemaName,
            connection_id: connectionId,
          }],
        };
      }
      if (sql.includes("count(attribute.attnum) FILTER")) {
        return { rows: options.catalogueRows ?? [] };
      }
      if (sql.includes("class.relname=$2 AND class.relkind IN ('r','p')")) {
        return {
          rows: options.targetRows ?? [{
            row_security: true,
            schema_readable: true,
            table_readable: true,
            approximate_rows: "130",
          }],
        };
      }
      if (sql.includes("FROM information_schema.columns")) {
        return {
          rows: options.metadataRows ?? [
            { column_name: "tenant_id", data_type: "text" },
            { column_name: "id", data_type: "text" },
            { column_name: "amount", data_type: "numeric" },
            { column_name: "updated_at", data_type: "timestamp with time zone" },
            { column_name: "oauth_token", data_type: "text" },
            { column_name: "credential_payload", data_type: "jsonb" },
            { column_name: "raw_payload", data_type: "json" },
            { column_name: "binary_payload", data_type: "bytea" },
          ],
        };
      }
      if (sql.includes("index.indisprimary")) {
        return { rows: options.primaryKeyRows ?? [{ column_name: "id" }] };
      }
      if (sql.includes(`FROM \"${schemaName}\".\"${tableName}\"`)) {
        return {
          rows: options.pageRows ?? [
            { id: "invoice-26", amount: "110.00", updated_at: "2026-08-17T00:00:00Z" },
            { id: "invoice-27", amount: null, updated_at: "2026-08-18T00:00:00Z" },
            { id: "invoice-28", amount: "42.00", updated_at: "2026-08-19T00:00:00Z" },
          ],
        };
      }
      return { rows: [] };
    },
    release() { statements.push({ sql: "RELEASE" }); },
  };
  return { client, statements };
}

function storeFor(client: DiagnosticPgClient): PostgresOperatorDiagnosticReadStore {
  const pool: DiagnosticPgPool = { async connect() { return client; } };
  return new PostgresOperatorDiagnosticReadStore(pool);
}

test("the read store verifies the exact binding and executes a bounded deterministic tenant page", async () => {
  const { client, statements } = fakeReadClient();
  const result = await storeFor(client).browseFivetranMyData(rowsGrant);
  assert.equal(result.kind, "rows");
  if (result.kind !== "rows") return;

  assert.deepEqual(result.table.columns, [
    { name: "id", dataType: "text" },
    { name: "amount", dataType: "numeric" },
    { name: "updated_at", dataType: "timestamp with time zone" },
  ]);
  assert.equal(result.table.rows.length, 2);
  assert.equal(result.table.hasMore, true);
  assert.equal(result.table.offset, 25);
  assert.equal(result.table.limit, 2);
  assert.equal(result.table.excludedColumnCount, 4);
  assert.equal(result.table.additionalColumnCount, 0);

  assert.ok(statements.some(({ sql }) =>
    sql === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert.ok(statements.some(({ sql }) => sql === "SET LOCAL ROLE diagnostic_ro"));
  assert.ok(statements.some(({ sql, parameters }) =>
    sql.includes("set_config('albert.tenant_capability',$1,true)")
      && parameters?.[0] === analyticalCapability));
  assert.ok(statements.some(({ sql, parameters }) =>
    sql.includes("pg_advisory_xact_lock_shared") && parameters?.[0] === tenantId));

  const binding = statements.find(({ sql }) =>
    sql.includes("FROM ingestion.fivetran_destination_bindings"));
  assert.deepEqual(binding?.parameters, [tenantId, [schemaName]]);
  assert.match(binding?.sql ?? "", /tenant_id=\$1 AND destination_schema=ANY\(\$2::text\[\]\)/u);

  const page = statements.find(({ sql }) => sql.includes(`FROM \"${schemaName}\".\"${tableName}\"`));
  assert.ok(page);
  assert.match(page.sql, /WHERE tenant_id=\$1/u);
  assert.match(page.sql, /ORDER BY "id" ASC NULLS LAST/u);
  assert.match(page.sql, /LIMIT \$2 OFFSET \$3/u);
  assert.match(page.sql, /left\("id"::text,500\)/u);
  assert.doesNotMatch(page.sql, /tenant_id AS|oauth_token|credential_payload|raw_payload|binary_payload/u);
  assert.deepEqual(page.parameters, [tenantId, 3, 25]);
  assert.equal(statements.at(-2)?.sql, "COMMIT");
  assert.equal(statements.at(-1)?.sql, "RELEASE");
});

test("catalogue defence in depth omits Fivetran and Albert system tables", async () => {
  const { client, statements } = fakeReadClient({
    catalogueRows: [
      {
        schema_name: schemaName,
        table_name: tableName,
        approximate_rows: "130",
        column_count: 8,
        tenant_scoped: true,
        row_security: true,
        schema_readable: true,
        table_readable: true,
      },
      {
        schema_name: schemaName,
        table_name: "_fivetran_audit",
        approximate_rows: "50",
        column_count: 4,
        tenant_scoped: true,
        row_security: true,
        schema_readable: true,
        table_readable: true,
      },
      {
        schema_name: schemaName,
        table_name: "fivetran_log",
        approximate_rows: "50",
        column_count: 4,
        tenant_scoped: true,
        row_security: true,
        schema_readable: true,
        table_readable: true,
      },
      {
        schema_name: schemaName,
        table_name: "albert_internal",
        approximate_rows: "50",
        column_count: 4,
        tenant_scoped: true,
        row_security: true,
        schema_readable: true,
        table_readable: true,
      },
      {
        schema_name: "xero_foreign",
        table_name: "foreign_rows",
        approximate_rows: "999",
        column_count: 3,
        tenant_scoped: true,
        row_security: true,
        schema_readable: true,
        table_readable: true,
      },
    ],
  });
  const result = await storeFor(client).browseFivetranMyData(catalogueGrant);
  assert.equal(result.kind, "catalogue");
  if (result.kind !== "catalogue") return;
  assert.deepEqual(result.catalogue.sources[0]?.tables, [{
    name: tableName,
    approximateRows: 130,
    columnCount: 8,
    available: true,
  }]);
  assert.equal(result.catalogue.totalRows, 130);
  const catalogue = statements.find(({ sql }) => sql.includes("count(attribute.attnum) FILTER"));
  assert.match(catalogue?.sql ?? "", /class\.relname !~ '\^\(fivetran_\|_fivetran_\|albert_\)'/u);
  assert.deepEqual(catalogue?.parameters, [[schemaName]]);
});

test("foreign bindings and unstamped targets fail closed before a row query", async (context) => {
  await context.test("the analytical binding must match both schema and connection", async () => {
    const { client, statements } = fakeReadClient({
      bindingRows: [{ destination_schema: schemaName, connection_id: foreignConnectionId }],
    });
    await assert.rejects(
      () => storeFor(client).browseFivetranMyData(rowsGrant),
      (error) => (error as { diagnosticCode?: unknown }).diagnosticCode ===
        "FIVETRAN_MY_DATA_BINDING_MISMATCH",
    );
    assert.ok(statements.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(statements.some(({ sql }) => sql.includes(`FROM \"${schemaName}\".\"${tableName}\"`)), false);
  });

  await context.test("a table without the completed RLS/read stamp is unavailable", async () => {
    const { client, statements } = fakeReadClient({
      targetRows: [{
        row_security: false,
        schema_readable: true,
        table_readable: false,
        approximate_rows: "130",
      }],
    });
    await assert.rejects(
      () => storeFor(client).browseFivetranMyData(rowsGrant),
      (error) => (error as { diagnosticCode?: unknown }).diagnosticCode ===
        "FIVETRAN_MY_DATA_TABLE_NOT_READY",
    );
    assert.ok(statements.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(statements.some(({ sql }) => sql.includes("FROM information_schema.columns")), false);
  });
});

test("grant and result contracts bind row targets and enforce hard pagination bounds", () => {
  assert.equal(fivetranMyDataGrantSchema.safeParse(rowsGrant).success, true);
  assert.equal(fivetranMyDataGrantSchema.safeParse({
    ...rowsGrant,
    schema_name: "xero_foreign",
  }).success, false);
  assert.equal(fivetranMyDataGrantSchema.safeParse({
    ...rowsGrant,
    row_limit: 51,
  }).success, false);
  assert.equal(fivetranMyDataGrantSchema.safeParse({
    ...rowsGrant,
    row_offset: 10_000_001,
  }).success, false);
  assert.equal(fivetranMyDataGrantSchema.safeParse({
    ...catalogueGrant,
    table_name: tableName,
  }).success, false);
  const validResult = rowsResult();
  assert.equal(validResult.kind, "rows");
  if (validResult.kind !== "rows") return;
  assert.equal(fivetranMyDataResultSchema.safeParse({
    ...validResult,
    table: {
      ...validResult.table,
      rows: Array.from({ length: 51 }, (_, index) => ({ id: String(index), amount: null })),
    },
  }).success, false);
});
