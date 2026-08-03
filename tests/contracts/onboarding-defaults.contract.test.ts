import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration=[
  "infra/migrations/control-plane/0014_m7_blocking_question_allowlist.sql",
  "infra/migrations/control-plane/0052_m6_flagship_employee_performance_lenses.sql",
].map((path)=>readFileSync(resolve(path),"utf8")).join("\n");
const workspace=readFileSync(
  resolve("services/control-plane/src/connections-workspace.ts"),
  "utf8",
);
const semanticContext=readFileSync(
  resolve("services/semantic-query/src/postgres-adapters.ts"),
  "utf8",
);
const liveAgent=readFileSync(
  resolve("services/conversation/src/live.ts"),
  "utf8",
);

test("blocking questions are an exact database allowlist matching the live workspace",()=>{
  for(const [question,options] of [
    ["sales-lens",["ex-gst","inc-gst"]],
    ["trading-day",["midnight","2am","4am"]],
    ["employee-performance",["net-sales","gross-profit","profit-per-hour"]],
    ["pos-posting-topology",["daily-summary","line-by-line","not-sure"]],
  ] as const){
    assert.match(migration,new RegExp(`p_question_id='${question}'`));
    assert.match(workspace,new RegExp(`id: "${question}"`));
    for(const option of options){
      assert.match(migration,new RegExp(`'${option}'`));
      assert.match(workspace,new RegExp(`id: "${option}"`));
    }
  }
  assert.match(migration,/blocking question option is not allowlisted/);
  assert.match(migration,/previous_option=p_option_id[\s\S]*RETURN/);
});

test("answers publish operative defaults and the semantic agent receives them with the dossier",()=>{
  assert.match(migration,/sales\.default_metric/);
  assert.match(migration,/trading_day_cutoff/);
  assert.match(migration,/employee\.performance_default/);
  assert.match(migration,/reconciliation\.pos_posting_topology/);
  assert.match(migration,/profit-per-hour' THEN 'composites\.gross_profit_per_labour_hour'/);
  assert.match(workspace,/profit-per-hour", label: "Gross profit per worked hour"/);
  assert.match(migration,/semantic_runtime_dossier_read/);
  assert.match(semanticContext,/FROM control_plane\.dossiers AS dossier/);
  assert.match(semanticContext,/copyAllowlistedDefault/);
  assert.match(liveAgent,/confirmed defaults and bounded business dossier/);
  assert.match(liveAgent,/Apply a relevant confirmed default/);
});
