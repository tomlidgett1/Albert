import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.js";
import {
  PUBLIC_SPECIALIST_AGENT_DEFINITIONS,
  SPECIALIST_AGENT_DEFINITIONS,
  getPublicSpecialistAgentDefinition,
  getSpecialistAgentDefinition,
  normalizeSpecialistAgentId,
  specializeAgentConfig,
} from "../../packages/albert-v3/src/specialist-agents/registry.js";

test("specialist registry normalizes known IDs and fails unknown IDs closed to general", () => {
  assert.equal(normalizeSpecialistAgentId(" customers "), "customers");
  assert.equal(normalizeSpecialistAgentId("CUSTOMERS"), "customers");
  assert.equal(normalizeSpecialistAgentId("general"), "general");
  assert.equal(normalizeSpecialistAgentId("inventory"), "general");
  assert.equal(normalizeSpecialistAgentId(null), "general");
  assert.equal(getSpecialistAgentDefinition("future-agent").id, "general");
  assert.equal(getPublicSpecialistAgentDefinition({ id: "customers" }).id, "general");
});

test("full and public definitions are immutable, UI-ready, and backed by certified starters", () => {
  const base = loadAgentConfig();
  const certifiedNames = new Set(base.certifiedQueries.map(({ name }) => name));
  const viewNames = new Set(base.accessibleViews.map(({ name }) => name));
  const skillNames = new Set(base.skills.map(({ name }) => name));
  assert.deepEqual(PUBLIC_SPECIALIST_AGENT_DEFINITIONS.map(({ id }) => id), ["general", "customers"]);

  for (const definition of Object.values(SPECIALIST_AGENT_DEFINITIONS)) {
    assert.ok(Object.isFrozen(definition));
    assert.ok(definition.starterPrompts.length >= 4 && definition.starterPrompts.length <= 6);
    assert.ok(definition.primaryViews.length > 0);
    assert.ok(definition.recommendedSkills.length > 0);
    assert.ok(definition.latency.targetVerifiedP95Ms < definition.latency.targetAdHocP95Ms);
    assert.ok(definition.evaluation.minimumCases >= 40);
    for (const starter of definition.starterPrompts) {
      assert.ok(certifiedNames.has(starter.certifiedQueryName), `${definition.id} starter ${starter.id} is not certified`);
    }
    for (const view of [...definition.primaryViews, ...definition.supportingViews]) {
      assert.ok(viewNames.has(view), `${definition.id} references unknown view ${view}`);
    }
    for (const skill of definition.recommendedSkills) {
      assert.ok(skillNames.has(skill), `${definition.id} references unknown skill ${skill}`);
    }
  }

  for (const definition of PUBLIC_SPECIALIST_AGENT_DEFINITIONS) {
    assert.ok(Object.isFrozen(definition));
    assert.equal("alwaysRule" in definition, false);
    assert.equal("priority" in definition, false);
    assert.ok(definition.ui.composerPlaceholder.length > 0);
  }
});

test("general and unknown selections return the base config by identity", () => {
  const base = loadAgentConfig();
  assert.equal(specializeAgentConfig(base, "general"), base);
  assert.equal(specializeAgentConfig(base, "not-installed"), base);
});

test("customer specialization is immutable and retains every governed capability", () => {
  const base = loadAgentConfig();
  const originalViewNames = base.accessibleViews.map(({ name }) => name);
  const originalCertifiedNames = base.certifiedQueries.map(({ name }) => name);
  const customer = specializeAgentConfig(base, "customers");

  assert.notEqual(customer, base);
  assert.equal(customer.specialistAgent, SPECIALIST_AGENT_DEFINITIONS.customers);
  assert.deepEqual(base.accessibleViews.map(({ name }) => name), originalViewNames, "base views mutated");
  assert.deepEqual(base.certifiedQueries.map(({ name }) => name), originalCertifiedNames, "base queries mutated");
  assert.equal(customer.accessibleViews.length, base.accessibleViews.length);
  assert.deepEqual(new Set(customer.accessibleViews.map(({ name }) => name)), new Set(originalViewNames));
  assert.equal(customer.certifiedQueries.length, base.certifiedQueries.length);
  assert.deepEqual(new Set(customer.certifiedQueries.map(({ name }) => name)), new Set(originalCertifiedNames));
  assert.deepEqual(new Set(customer.skills.map(({ name }) => name)), new Set(base.skills.map(({ name }) => name)));
  assert.deepEqual(
    new Set(customer.agentRequestedRules.map(({ name }) => name)),
    new Set(base.agentRequestedRules.map(({ name }) => name)),
  );
  assert.ok(customer.accessibleViews.every((view) => base.accessibleViews.includes(view)));
  assert.ok(customer.certifiedQueries.every((query) => base.certifiedQueries.includes(query)));
  assert.ok(Object.isFrozen(customer));
  assert.ok(Object.isFrozen(customer.accessibleViews));
  assert.ok(Object.isFrozen(customer.certifiedQueries));
});

test("customer specialization stably prioritizes customer evidence, skills, rules, and verified queries", () => {
  const base = loadAgentConfig();
  const customer = specializeAgentConfig(base, "customers");
  const expectedViews = SPECIALIST_AGENT_DEFINITIONS.customers.primaryViews
    .filter((name) => base.accessibleViews.some((view) => view.name === name));
  assert.deepEqual(customer.accessibleViews.slice(0, expectedViews.length).map(({ name }) => name), expectedViews);
  assert.equal(customer.accessibleViews[4]?.name, "xero_finance_analytics");
  assert.equal(customer.skills[0]?.name, "customer-health-review");
  assert.equal(customer.agentRequestedRules[0]?.name, "new-vs-returning");

  const starterQueries = SPECIALIST_AGENT_DEFINITIONS.customers.starterPrompts.map(({ certifiedQueryName }) => certifiedQueryName);
  assert.deepEqual(customer.certifiedQueries.slice(0, starterQueries.length).map(({ name }) => name), starterQueries);

  const prioritizedViews = new Set([
    ...SPECIALIST_AGENT_DEFINITIONS.customers.primaryViews,
    ...SPECIALIST_AGENT_DEFINITIONS.customers.supportingViews,
  ]);
  assert.deepEqual(
    customer.accessibleViews.filter(({ name }) => !prioritizedViews.has(name)).map(({ name }) => name),
    base.accessibleViews.filter(({ name }) => !prioritizedViews.has(name)).map(({ name }) => name),
    "unprioritized views lost their original order",
  );

  const secondPass = specializeAgentConfig(customer, "customers");
  assert.deepEqual(secondPass.accessibleViews.map(({ name }) => name), customer.accessibleViews.map(({ name }) => name));
  assert.equal(secondPass.alwaysRules.filter(({ name }) => name === "specialist-customers-policy").length, 1);
});

test("customer policy defaults to privacy and never promises PII exposure or autonomous write-back", () => {
  const customer = specializeAgentConfig(loadAgentConfig(), "customers");
  const policy = customer.alwaysRules.find(({ name }) => name === "specialist-customers-policy");
  assert.ok(policy);
  assert.equal(customer.alwaysRules[0], policy);
  assert.match(policy.body, /aggregates by default/iu);
  assert.match(policy.body, /never expose email, phone, street address, notes/iu);
  assert.match(policy.body, /contactability is not marketing consent/iu);
  assert.match(policy.body, /never send customer values to web tools/iu);
  assert.match(policy.body, /never claim or perform marketing sends, autonomous source-system write-back/iu);
  assert.match(policy.body, /recommendations are analysis-only drafts/iu);
  assert.match(customer.alwaysRulesBlock, /specialist customer analyst|customer analyst/iu);
  assert.doesNotMatch(policy.body, /(?:will|can) (?:email|phone|text|message|write back|update) customers/iu);
});
