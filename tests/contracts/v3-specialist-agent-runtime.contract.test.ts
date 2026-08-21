import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadAgentConfig, findCertifiedQuery } from "../../packages/albert-v3/src/agent-config/loader.js";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { classifierInstructions } from "../../packages/albert-v3/src/engine/orchestrator.js";
import { specialistAgentDefinitionDigest } from "../../packages/albert-v3/src/specialist-agents/digest.js";
import {
  SPECIALIST_AGENT_DEFINITIONS,
  matchVerifiedStarterPrompt,
  parseSpecialistAgentId,
  specialistAgentAllowedForRole,
  specializeAgentConfig,
} from "../../packages/albert-v3/src/specialist-agents/registry.js";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Customer Agent IDs, roles, versions, and policy receipts fail closed", () => {
  assert.equal(parseSpecialistAgentId("customers"), "customers");
  assert.equal(parseSpecialistAgentId("inventory"), null);
  assert.equal(specialistAgentAllowedForRole("customers", "owner"), true);
  assert.equal(specialistAgentAllowedForRole("customers", "manager"), true);
  assert.equal(specialistAgentAllowedForRole("customers", "bookkeeper"), false);
  assert.equal(specialistAgentAllowedForRole("general", undefined), true);

  const definition = SPECIALIST_AGENT_DEFINITIONS.customers;
  assert.equal(definition.version, 1);
  const digest = specialistAgentDefinitionDigest(definition);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(specialistAgentDefinitionDigest(definition), digest);
});

test("every displayed Customer starter is an exact reviewed recipe", () => {
  const config = specializeAgentConfig(loadAgentConfig(), "customers");
  for (const starter of config.specialistAgent.starterPrompts) {
    assert.equal(matchVerifiedStarterPrompt("customers", starter.prompt), starter);
    const query = findCertifiedQuery(starter.certifiedQueryName, config);
    assert.ok(query?.recipe, `${starter.id} must resolve to a recipe`);
  }
  assert.equal(matchVerifiedStarterPrompt("customers", "a novel customer question"), undefined);
});

test("the customer classifier has a focused doctrine without losing connected views", () => {
  const config = specializeAgentConfig(loadAgentConfig(), "customers");
  const instructions = classifierInstructions(config, [], ["lightspeed-r", "xero"]);
  assert.match(instructions, /Explicitly selected specialist: Customer Agent/u);
  assert.match(instructions, /focused starting point, not a restriction or a separate runtime/u);
  assert.match(instructions, /customer_analytics/u);
  assert.match(instructions, /sales_analytics/u);
  assert.match(instructions, /xero_finance_analytics/u);
  assert.match(instructions, /aggregates by default/iu);
});

test("signed Cube context binds the role and specialist receipt", () => {
  const token = signCubeJwt({
    secret: "specialist-agent-test-secret",
    securityContext: {
      tenant_id: "01KZN20VTX2EWW1TQ2AA3MCPW6",
      conversation_id: "01M0SPECIALISTCONVERSATION",
      turn_id: "01M0SPECIALISTCUSTOMERTURN",
      role: "owner",
      specialist_agent_id: "customers",
      specialist_agent_version: 1,
    },
  });
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(payload.role, "owner");
  assert.equal(payload.specialist_agent_id, "customers");
  assert.equal(payload.specialist_agent_version, 1);

  const cubeConfig = source("cube-playground/cube.js");
  assert.match(cubeConfig, /specialistAgentId === 'customers'/u);
  assert.match(cubeConfig, /\['owner', 'manager', 'internal_operator'\]\.includes\(role\)/u);
});

test("web, engine, and control plane preserve one immutable profile", () => {
  const route = source("app/api/v3-conversation/route.ts");
  assert.match(route, /specialistAgentId: z\.enum\(SPECIALIST_AGENT_IDS\)\.optional\(\)/u);
  assert.match(route, /specialistAgentAllowedForRole\(specialistAgentId, tenant\.role\)/u);
  assert.match(route, /specialistAgentDigest: specialistAgentDefinitionDigest/u);
  assert.match(route, /specialistAgentId === "general"/u, "specialists skip the auxiliary acknowledgement delay");
  assert.match(route, /runAlbertV3Turn\(\{[\s\S]*specialistAgentId,/u);

  const engine = source("packages/albert-v3/src/engine/engine.ts");
  assert.match(engine, /specializeAgentConfig\(loadAgentConfig\(\), specialistAgentId\)/u);
  assert.match(engine, /matchVerifiedStarterPrompt\(specialistAgent\.id, options\.message\)/u);
  assert.match(engine, /\$\{options\.tenantId\}:\$\{specialistAgent\.id\}:\$\{specialistAgent\.version\}/u);

  const migration = source("infra/migrations/control-plane/0157_m8_specialist_agent_profiles.sql");
  assert.match(migration, /conversation_turns_specialist_agent_guard/u);
  assert.match(migration, /conversation specialist agent profile is immutable/u);
  assert.match(migration, /'specialistAgentId'/u);
  assert.match(migration, /'specialistAgentVersion'/u);
  assert.match(migration, /'specialistAgentDigest'/u);
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/u);
});

test("ordinary customer surfaces do not publish direct contact or free-text PII", () => {
  const view = source("cube-playground/model/views/customer_analytics.yml");
  for (const forbidden of [
    "date_of_birth",
    "contacts_address1",
    "contacts_address2",
    "contacts_primary_email",
    "contacts_primary_phone",
    "customer_notes_note",
    "customer_custom_field_values_value_text",
  ]) {
    assert.doesNotMatch(view, new RegExp(`- ${forbidden}(?:\\s|$)`, "u"), forbidden);
  }
});
