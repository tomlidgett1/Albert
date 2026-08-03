import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isAllowlistedRememberedPreference,
  resolveAlbertPreferenceOption,
  semanticToolInputSchemas,
} from "../../packages/agent/src/semantic-tools.js";

const migration = read("infra/migrations/control-plane/0023_m6_one_use_clarification_confirmations.sql");
const route = read("app/api/conversation/route.ts");
const live = read("services/conversation/src/live.ts");
const semanticService = read("services/semantic-query/src/service.ts");
const preferenceStore = read("services/semantic-query/src/postgres-adapters.ts");

test("clarification tools expose only server-owned option ids", () => {
  const parsed = semanticToolInputSchemas.ask_user.parse({
    question: "Which employee-performance lens should I use?",
    options: [{ id: "employee.net_sales" }, { id: "employee.gross_margin" }],
  });
  assert.deepEqual(parsed.options, [{ id: "employee.net_sales" }, { id: "employee.gross_margin" }]);
  assert.throws(() => semanticToolInputSchemas.ask_user.parse({
    question: "Which lens?",
    options: [
      { id: "made.up", label: "Tampered", value: "arbitrary" },
      { id: "employee.net_sales" },
    ],
  }));
  assert.deepEqual(resolveAlbertPreferenceOption("employee.net_sales"), {
    id: "employee.net_sales",
    label: "Net sales",
    preference: "employee.performance_default",
    value: "commerce.net_sales_ex_gst",
  });
  assert.deepEqual(resolveAlbertPreferenceOption("employee.gross_profit_per_labour_hour"), {
    id: "employee.gross_profit_per_labour_hour",
    label: "Gross profit per worked hour",
    preference: "employee.performance_default",
    value: "composites.gross_profit_per_labour_hour",
  });
});

test("remember accepts only an exact allowlisted key/value pair", () => {
  assert.equal(isAllowlistedRememberedPreference(
    "employee.performance_default",
    "commerce.net_sales_ex_gst",
  ), true);
  assert.equal(isAllowlistedRememberedPreference(
    "sales.default_metric",
    "commerce.gross_margin",
  ), false);
  assert.match(live, /input\.preference !== context\.confirmationReceipt\.preference[\s\S]*input\.value !== context\.confirmationReceipt\.value/u);
  assert.match(semanticService, /parsed\.preference !== context\.confirmedPreference[\s\S]*parsed\.value !== context\.confirmedValue/u);
  assert.match(preferenceStore, /isAllowlistedRememberedPreference\(preference,value\)/u);
});

test("the browser references one prior option receipt and cannot submit confirmation values", () => {
  assert.match(route, /confirmedOption:[\s\S]*offeredTurnId:[\s\S]*optionId: z\.enum\(ALBERT_PREFERENCE_OPTION_IDS\)/u);
  assert.doesNotMatch(route, /confirmedChoice|confirmedOption:[\s\S]{0,300}\bvalue:/u);
  assert.match(route, /confirmedOption: parsed\.data\.confirmedOption/u);
  assert.match(route, /confirmedPreference: begun\.confirmedPreference/u);
});

test("database receipts are same-conversation, finalized, single-use and replay-bound", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.clarification_options/u);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS clarification_prompts_one_per_consuming_turn/u);
  assert.match(migration, /option\.conversation_id=resolved_conversation[\s\S]*option\.offered_turn_id=p_confirmation_turn_id[\s\S]*option\.option_id=p_confirmation_option_id/u);
  assert.match(migration, /prompt\.consumed_turn_id IS NULL[\s\S]*offered_turn\.status='completed'[\s\S]*artifact\.answer_state='clarification'/u);
  assert.match(migration, /turn confirmation replay does not match the immutable request/u);
  assert.match(migration, /UPDATE control_plane\.clarification_prompts[\s\S]*SET consumed_turn_id=p_turn_id,[\s\S]*consumed_option_id=p_confirmation_option_id/u);
  assert.match(migration, /tenant_overlays_preference_allowlist/u);
});

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}
