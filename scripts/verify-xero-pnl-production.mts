import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { hydrateViewSchemas } from "../packages/albert-v3/src/cube/catalogue.js";
import { validateCubeQuery } from "../packages/albert-v3/src/cube/client.js";
import {
  LEASE_CONVERSATION_ID,
  LEASE_TURN_ID,
  TENANT_ID,
  createEvalCube,
  dateTokens,
  loadEnv,
} from "./albert-eval/lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const migrationId = "0173_m5_xero_authoritative_profit_and_loss.sql";
const migrationPath = path.join(root, "infra/migrations/analytical", migrationId);

function numberAt(row: Readonly<Record<string, unknown>>, member: string): number {
  const value = Number(row[member]);
  assert.ok(Number.isFinite(value), `${member} is missing or non-numeric`);
  return value;
}

function withinCent(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.01;
}

async function verifyMigrationLedger(databaseUrl: string) {
  const checksum = createHash("sha256").update(readFileSync(migrationPath)).digest("hex");
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: "albert-xero-pnl-production-verifier",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query<{
      migration_id: string;
      checksum_sha256: string;
      applied_at: Date;
    }>(
      `SELECT migration_id,checksum_sha256,applied_at
         FROM albert_migrations.applied_migration
        WHERE stream='analytical' AND migration_id=$1`,
      [migrationId],
    );
    await client.query("ROLLBACK");
    const row = result.rows[0];
    assert.ok(row, `${migrationId} is not applied in production`);
    assert.equal(row.checksum_sha256, checksum, `${migrationId} checksum differs from production`);
    return { migrationId: row.migration_id, checksum, appliedAt: row.applied_at.toISOString() };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function verifyXeroProfitAndLossProduction() {
  const env = loadEnv();
  const databaseUrl = env.ANALYTICAL_ADMIN_DATABASE_URL?.trim();
  assert.ok(databaseUrl, "ANALYTICAL_ADMIN_DATABASE_URL is required for read-only ledger verification");
  const migration = await verifyMigrationLedger(databaseUrl);

  const cube = createEvalCube(env);
  const catalogue = await cube.fetchCatalogue();
  for (const view of [
    "xero_profit_and_loss_analytics",
    "xero_profit_and_loss_account_analytics",
    "xero_finance_analytics",
  ]) assert.ok(catalogue.views.some((candidate) => candidate.name === view), `production Cube lacks ${view}`);

  const finance = catalogue.views.find((view) => view.name === "xero_finance_analytics")!;
  const legacyMember = finance.members.find((member) => member.name === "xero_finance_analytics.pnl_net_profit");
  assert.equal(legacyMember?.aiHidden, true, "legacy pnl_net_profit is not AI-hidden");
  const replayValidation = validateCubeQuery({
    measures: ["xero_finance_analytics.pnl_net_profit"],
  }, catalogue);
  assert.equal("error" in replayValidation, false, "legacy pnl_net_profit is no longer replay-valid");
  const modelSchema = hydrateViewSchemas(catalogue, ["xero_finance_analytics"], [{
    name: "xero_finance_analytics",
    connector: "xero",
    guidance: "Operational finance; P&L lives in the dedicated report views.",
  }]);
  assert.equal(
    modelSchema.views[0]?.members.some((member) => member.name === "xero_finance_analytics.pnl_net_profit"),
    false,
    "legacy pnl_net_profit is still model-visible",
  );

  const dates = dateTokens();
  const headlineQuery = {
    measures: [
      "xero_profit_and_loss_analytics.report_periods",
      "xero_profit_and_loss_analytics.total_income",
      "xero_profit_and_loss_analytics.total_expenses",
      "xero_profit_and_loss_analytics.wage_expenses",
      "xero_profit_and_loss_analytics.employer_super_expenses",
      "xero_profit_and_loss_analytics.gross_profit",
      "xero_profit_and_loss_analytics.net_profit",
      "xero_profit_and_loss_analytics.net_profit_reconciliation_variance",
      "xero_profit_and_loss_analytics.gross_profit_reconciliation_variance",
    ],
    dimensions: ["xero_profit_and_loss_analytics.currency"],
    timeDimensions: [{
      dimension: "xero_profit_and_loss_analytics.period_start",
      dateRange: [dates.fy_start, dates.today],
    }],
    timezone: "Australia/Melbourne",
  } as const;
  const headlineLoad = await cube.loadQuery(headlineQuery);
  assert.equal(headlineLoad.result.ok, true, headlineLoad.result.ok ? undefined : headlineLoad.result.error);
  assert.equal(headlineLoad.result.rows.length, 1, "headline P&L must return one base-currency row");
  const headline = headlineLoad.result.rows[0]!;
  const periods = numberAt(headline, "xero_profit_and_loss_analytics.report_periods");
  const income = numberAt(headline, "xero_profit_and_loss_analytics.total_income");
  const expenses = numberAt(headline, "xero_profit_and_loss_analytics.total_expenses");
  const wages = numberAt(headline, "xero_profit_and_loss_analytics.wage_expenses");
  const superannuation = numberAt(headline, "xero_profit_and_loss_analytics.employer_super_expenses");
  const netProfit = numberAt(headline, "xero_profit_and_loss_analytics.net_profit");
  const netVariance = numberAt(headline, "xero_profit_and_loss_analytics.net_profit_reconciliation_variance");
  const grossVariance = numberAt(headline, "xero_profit_and_loss_analytics.gross_profit_reconciliation_variance");
  assert.ok(periods > 0, "current FY has no Xero report periods");
  assert.ok(wages > 0, "current FY mapped wages are absent or zero");
  assert.ok(withinCent(netProfit, income - expenses), "Net Profit does not equal total income minus total expenses");
  assert.ok(Math.abs(netVariance) <= 0.01, `Net Profit variance is ${netVariance}`);
  assert.ok(Math.abs(grossVariance) <= 0.01, `Gross Profit variance is ${grossVariance}`);

  const accountQuery = {
    measures: [
      "xero_profit_and_loss_account_analytics.statement_amount",
      "xero_profit_and_loss_account_analytics.wage_expenses",
    ],
    dimensions: [
      "xero_profit_and_loss_account_analytics.account_name",
      "xero_profit_and_loss_account_analytics.reporting_code",
    ],
    filters: [{
      member: "xero_profit_and_loss_account_analytics.is_wage_expense",
      operator: "equals" as const,
      values: ["true"],
    }],
    timeDimensions: [{
      dimension: "xero_profit_and_loss_account_analytics.period_start",
      dateRange: [dates.fy_start, dates.today],
    }],
    timezone: "Australia/Melbourne",
  } as const;
  const accountLoad = await cube.loadQuery(accountQuery);
  assert.equal(accountLoad.result.ok, true, accountLoad.result.ok ? undefined : accountLoad.result.error);
  assert.ok(accountLoad.result.rows.length > 0, "no mapped wage account rows returned");
  const accountWages = accountLoad.result.rows.reduce(
    (sum, row) => sum + numberAt(row, "xero_profit_and_loss_account_analytics.statement_amount"),
    0,
  );
  assert.ok(withinCent(accountWages, wages), "wage account rows do not reconcile to headline wage expense");

  return Object.freeze({
    schemaVersion: 1,
    tenantId: TENANT_ID,
    lease: { conversationId: LEASE_CONVERSATION_ID, turnId: LEASE_TURN_ID },
    migration,
    cube: {
      viewCount: catalogue.views.length,
      headlineView: true,
      accountView: true,
      legacyReplayValid: true,
      legacyModelHidden: true,
    },
    currentFinancialYear: {
      from: dates.fy_start,
      through: dates.today,
      periods,
      currency: String(headline["xero_profit_and_loss_analytics.currency"] ?? ""),
      income,
      expenses,
      wages,
      superannuation,
      netProfit,
      netVariance,
      grossVariance,
      wageAccountRows: accountLoad.result.rows.length,
    },
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const proof = await verifyXeroProfitAndLossProduction();
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
}
