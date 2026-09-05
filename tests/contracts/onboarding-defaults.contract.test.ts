import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import envelope from "../../contracts/blocking-questions.v1.json";
import {
  ALBERT_BLOCKING_QUESTIONS_CONTRACT,
  ALBERT_BLOCKING_QUESTIONS_CONTRACT_CANONICAL_JSON,
  ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST,
  assertBlockingQuestionContractEnvelope,
  blockingQuestionContractSqlLiteral,
  sha256CanonicalJson,
} from "../../contracts/blocking-questions.mjs";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";

const migration = readFileSync(
  resolve("infra/migrations/control-plane/0066_m1_content_addressed_blocking_questions.sql"),
  "utf8",
);
const workspaceSource = readFileSync(
  resolve("services/control-plane/src/connections-workspace.ts"),
  "utf8",
);

function changedEnvelope(change: (contract: typeof envelope.contract) => void) {
  const changed = structuredClone(envelope);
  change(changed.contract);
  return changed;
}

test("blocking-question wording, choices, prerequisites, and mappings share one canonical digest", () => {
  assert.equal(
    sha256CanonicalJson(ALBERT_BLOCKING_QUESTIONS_CONTRACT),
    ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST,
  );
  assert.equal(envelope.digest, ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST);
  assert.equal(blockingQuestionContractSqlLiteral(),
    `$blocking_questions$${ALBERT_BLOCKING_QUESTIONS_CONTRACT_CANONICAL_JSON}$blocking_questions$`);

  const changedCopy = changedEnvelope((contract) => {
    contract.questions[0]!.question = "Which sales figure should Albert use?";
  });
  const changedOptions = changedEnvelope((contract) => {
    contract.questions[1]!.options[0]!.label = "Calendar midnight";
  });
  const changedPrerequisites = changedEnvelope((contract) => {
    contract.questions[2]!.connectorPrerequisites = ["lightspeed-r"];
  });
  const changedMapping = changedEnvelope((contract) => {
    contract.questions[3]!.options[0]!.overlayMutations[0]!.value = "individual_transactions";
  });
  for (const changed of [changedCopy, changedOptions, changedPrerequisites, changedMapping]) {
    assert.throws(
      () => assertBlockingQuestionContractEnvelope(changed),
      /changed without a matching canonical SHA-256 digest/u,
    );
  }
});

test("migration 0066 installs the mechanically canonical contract byte-for-byte", () => {
  const installed = migration.match(/\$blocking_questions\$(.*?)\$blocking_questions\$/su)?.[1];
  assert.equal(installed, ALBERT_BLOCKING_QUESTIONS_CONTRACT_CANONICAL_JSON);
  assert.equal(sha256CanonicalJson(JSON.parse(installed!)), ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST);
  assert.match(migration, new RegExp(ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST, "u"));
  assert.match(migration, /contract_digest = encode\([\s\S]*extensions\.digest/u);
  assert.match(migration, /blocking question contract is immutable/u);
  assert.match(migration, /REVOKE ALL ON TABLE control_plane\.blocking_question_contract[\s\S]*authenticated, service_role/u);
});

test("the RPC derives allowlisting, prerequisites, and mutations from the installed contract", () => {
  assert.match(migration, /jsonb_array_elements\([\s\S]*contract_canonical_json::jsonb -> 'questions'/u);
  assert.match(migration, /jsonb_array_elements_text\([\s\S]*'connectorPrerequisites'/u);
  assert.match(migration, /connection\.status NOT IN \('pending', 'disconnected'\)/u);
  assert.match(migration, /extensions\.albert_auth_jwt\(\) ->> 'role'/u);
  assert.match(migration, /request_role IS DISTINCT FROM 'authenticated'/u);
  assert.doesNotMatch(migration, /\bauth\.(?:users\b|uid\s*\(|jwt\s*\()/u);
  assert.match(migration, /selected_option -> 'overlayMutations'/u);
  assert.match(migration, /next_overlay := jsonb_set\([\s\S]*overlay_path[\s\S]*overlay_mutation -> 'value'/u);
  assert.doesNotMatch(migration, /CASE\s+p_question_id/u);
  assert.doesNotMatch(migration, /p_question_id\s*=\s*'sales-lens'/u);
  assert.doesNotMatch(migration, /p_option_id\s+IN\s*\(/u);
});

test("the workspace renders only the UI projection and uses contract prerequisites", () => {
  assert.match(workspaceSource, /ALBERT_BLOCKING_QUESTIONS_CONTRACT\.questions/u);
  assert.match(workspaceSource, /question\.connectorPrerequisites/u);
  assert.doesNotMatch(workspaceSource, /const blockingQuestions/u);
  assert.doesNotMatch(workspaceSource, /overlayMutations/u);

  const workspace = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "Albert Bikes",
    connections: [
      {
        connection_id: "01J00000000000000000000011",
        connector_key: "lightspeed-r",
        display_name: "Albert Bikes",
        status: "connected",
        auth_health: "healthy",
        readiness: [],
      },
      {
        connection_id: "01J00000000000000000000012",
        connector_key: "deputy",
        display_name: "Albert Bikes Deputy",
        status: "degraded",
        auth_health: "error",
        readiness: [],
      },
    ],
    identity_review_tasks: [],
    blocking_answers: { "sales-lens": "ex-gst" },
    oauth_sessions: [],
  }, "Australia/Melbourne");

  assert.deepEqual(
    workspace.blockingQuestions.map((question) => question.id),
    ["sales-lens", "trading-day", "employee-performance"],
  );
  assert.equal(workspace.blockingQuestions[0]?.question,
    "When you say sales, which figure should Albert use by default?");
  assert.equal(workspace.blockingQuestions[0]?.selectedOptionId, "ex-gst");
  assert.deepEqual(Object.keys(workspace.blockingQuestions[0] ?? {}).sort(),
    ["id", "label", "options", "question", "selectedOptionId"]);
});
