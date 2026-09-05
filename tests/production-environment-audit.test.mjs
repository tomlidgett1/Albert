import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { load as loadYaml } from "js-yaml";
import {
  FLY_APP_VARIABLES,
  auditGithubReleaseAuthority,
  auditProductionEnvironment,
  createSupabaseClient,
  createGithubClient,
  formatHumanSummary,
  loadProductionRequirements,
  parseWorkflowYaml,
  parseVercelInventoryNames,
} from "../scripts/audit-production-environment.mjs";
import {
  ALBERT_AUTH_PASSWORD_MIN_LENGTH,
  ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS,
  expectedSupabaseAuthRedirects,
} from "../scripts/supabase-auth-production-policy.mjs";

const rootDirectory = path.resolve(import.meta.dirname, "..");
const repository = "tomlidgett1/Albert";
const projectRef = "abcdefghijklmnopqrst";
const flyOrganization = "albert-production";
const publicOrigin = "https://albert.example";

function validAuthConfig() {
  return {
    site_url: publicOrigin,
    uri_allow_list: expectedSupabaseAuthRedirects(publicOrigin).join(","),
    external_anonymous_users_enabled: false,
    disable_signup: false,
    external_email_enabled: true,
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,
    smtp_admin_email: "no-reply@auth.albert.example",
    smtp_host: "smtp.auth.albert.example",
    smtp_port: "587",
    smtp_user: "albert-production",
    smtp_sender_name: "Albert",
    password_min_length: ALBERT_AUTH_PASSWORD_MIN_LENGTH,
    password_required_characters: ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS,
    password_hibp_enabled: true,
    refresh_token_rotation_enabled: true,
  };
}

async function validFixture() {
  const requirements = await loadProductionRequirements(rootDirectory);
  const vercelProject = JSON.parse(await readFile(path.join(rootDirectory, "deploy/vercel-project.json"), "utf8"));
  const contract = JSON.parse(await readFile(path.join(rootDirectory, "deploy/runtime-contract.json"), "utf8"));
  const source = {
    FLY_ORGANIZATION_SLUG: flyOrganization,
    ALBERT_PUBLIC_ORIGIN: publicOrigin,
    ALBERT_RELEASE_AUTHORITY_CREATOR_APP_ID: "42",
    ALBERT_VENDOR_ATTESTOR_TAG_ISSUER_APP_ID: "43",
  };
  const apps = FLY_APP_VARIABLES.map((variable, index) => {
    const name = `albert-${index + 1}-production`;
    source[variable] = name;
    return { name, organization: flyOrganization, status: "deployed" };
  });
  const environmentSecrets = Object.fromEntries(Object.entries(requirements.environments).map(([name, requirement]) => [
    name,
    requirement.secrets.map((secretName) => ({
      name: secretName,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
      value: "NEVER-OUTPUT-SECRET-VALUE",
    })),
  ]));
  const environmentVariables = Object.fromEntries(Object.entries(requirements.environments).map(([name, requirement]) => [
    name,
    requirement.variables.map((variableName) => ({
      name: variableName,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
      value: "NEVER-OUTPUT-VARIABLE-VALUE",
    })),
  ]));
  const githubClient = {
    async repository() { return repository; },
    async verifyAuthentication() { return true; },
    async environment(_repository, name) {
      return {
        name,
        reviewers: [{ id: 7, login: "release-reviewers", type: "Team" }],
        preventSelfReview: true,
        canAdminsBypass: false,
        protectedBranches: false,
        customBranchPolicies: true,
      };
    },
    async secrets(_repository, name) { return environmentSecrets[name]; },
    async variables(_repository, name) { return environmentVariables[name]; },
    async deploymentPolicies(_repository, name) {
      if (name === "vendor-attestor-trust") return [{ name: "vendor-attestor-v*", type: "tag" }];
      return [{ name: "albert-release-authority-v*", type: "tag" }];
    },
    async classicBranchProtection() {
      return {
        statusChecks: requirements.requiredStatusChecks,
        strictStatusChecks: true,
        requiredApprovingReviews: 1,
        dismissStaleReviews: true,
        enforceAdmins: true,
      };
    },
    async branchRules() { return []; },
    async releaseAuthorityRulesets() {
      return [
        {
          id: 100,
          name: "Albert release authority creation",
          enforcement: "active",
          target: "tag",
          include: ["refs/tags/albert-release-authority-v*"],
          bypassActorsPresent: true,
          bypassActors: [{ actorId: 42, actorType: "Integration", bypassMode: "always" }],
          rules: ["creation"],
        },
        {
          id: 101,
          name: "Albert release authority immutability",
          enforcement: "active",
          target: "tag",
          include: ["refs/tags/albert-release-authority-v*"],
          bypassActorsPresent: true,
          bypassActors: [],
          rules: ["update", "deletion"],
        },
        {
          id: 102,
          name: "Albert vendor attestor creation",
          enforcement: "active",
          target: "tag",
          include: ["refs/tags/vendor-attestor-v*"],
          bypassActorsPresent: true,
          bypassActors: [{ actorId: 43, actorType: "Integration", bypassMode: "always" }],
          rules: ["creation"],
        },
        {
          id: 103,
          name: "Albert vendor attestor immutability",
          enforcement: "active",
          target: "tag",
          include: ["refs/tags/vendor-attestor-v*"],
          bypassActorsPresent: true,
          bypassActors: [],
          rules: ["update", "deletion"],
        },
      ];
    },
  };
  const flyClient = {
    async verifyAuthentication() { return true; },
    async apps() { return apps; },
  };
  const supabaseClient = {
    async projects() { return [{ ref: projectRef, region: "ap-southeast-2", status: "ACTIVE_HEALTHY", password: "NEVER-OUTPUT" }]; },
    async authConfig() { return { ...validAuthConfig(), ignored_secret: "NEVER-OUTPUT-AUTH-SECRET" }; },
  };
  const vercelInventory = {
    projectId: vercelProject.projectId,
    teamId: vercelProject.teamId,
    runtimeNames: [...contract.runtimes.web.requiredRuntimeValues],
  };
  return {
    requirements,
    source,
    apps,
    environmentSecrets,
    environmentVariables,
    githubClient,
    flyClient,
    supabaseClient,
    vercelInventory,
  };
}

test("production audit derives every protected workflow inventory and passes complete metadata", async () => {
  const fixture = await validFixture();
  assert.ok(fixture.requirements.environments.production.secrets.includes("SUPABASE_MANAGEMENT_TOKEN"));
  assert.equal(fixture.requirements.environments.production.secrets.includes("ALBERT_VERCEL_READ_TOKEN"), false);
  assert.equal(fixture.requirements.environments.production.variables.includes("ALBERT_VERCEL_PROJECT_ID"), false);
  assert.ok(fixture.requirements.environments.production.variables.includes("ALBERT_CONTROL_PLANE_PROJECT_REF"));
  assert.ok(fixture.requirements.environments.production.variables.includes("FLY_CUBE_APP"));
  assert.ok(fixture.requirements.environments.production.variables.includes("CUBE_API_URL"));
  assert.ok(fixture.requirements.environments.production.secrets.includes("FLY_CUBE_API_TOKEN"));
  assert.ok(fixture.requirements.environments.production.secrets.includes("ALBERT_RELEASE_CUBE_SMOKE_CONTROL_DATABASE_URL"));
  assert.ok(fixture.requirements.environments.production.secrets.includes("ALBERT_RELEASE_CUBE_SMOKE_TENANT_ID"));
  assert.ok(fixture.requirements.environments.production.variables.includes("ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST"));
  assert.ok(fixture.vercelInventory.runtimeNames.includes("ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST"));
  assert.ok(fixture.requirements.environments.production.secrets.includes("ALBERT_CAPACITY_ED25519_PUBLIC_KEY_BASE64"));
  assert.ok(fixture.requirements.environments.production.secrets.includes("ALBERT_VENDOR_ATTESTOR_TLS_CLIENT_KEY_BASE64"));
  assert.ok(fixture.requirements.environments.production.variables.includes("ALBERT_VENDOR_ATTESTOR_EXPECTED_BUILD_DIGEST"));
  assert.ok(fixture.requirements.environments.production.secrets.includes("ALBERT_GITHUB_CONFIGURATION_AUDIT_TOKEN"));
  assert.equal(fixture.requirements.environments.staging, undefined);
  assert.ok(!fixture.requirements.environments.production.variables.includes("ANALYTICAL_CAPABILITY_PREVIOUS_KEY_ID"));
  assert.ok(fixture.requirements.environments["staging-capacity"].secrets.includes("FLY_CAPACITY_ORG_API_TOKEN"));
  assert.ok(fixture.requirements.environments["dogfood-staging"].secrets.includes("ALBERT_DOGFOOD_ACCEPTANCE_ED25519_PRIVATE_KEY_BASE64URL"));
  assert.ok(fixture.requirements.environments["dogfood-staging"].variables.includes("ALBERT_DOGFOOD_PUBLIC_ORIGIN"));
  assert.ok(fixture.requirements.environments["dogfood-staging"].variables.includes("ALBERT_DOGFOOD_ONBOARDING_RECIPIENT_RSA_PUBLIC_KEY_BASE64URL"));
  assert.ok(fixture.requirements.environments["vendor-attestor-trust"].secrets.includes("ALBERT_VENDOR_ATTESTOR_ED25519_PRIVATE_KEY_BASE64"));
  assert.ok(fixture.requirements.environments["vendor-attestor-trust"].secrets.includes("ALBERT_GITHUB_CONFIGURATION_AUDIT_TOKEN"));
  assert.deepEqual(fixture.requirements.requiredStatusChecks, [
    "analytical-database",
    "browser-acceptance",
    "control-plane-database",
    "verify",
  ]);

  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
    now: new Date("2026-08-04T00:00:00Z"),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  const rendered = `${JSON.stringify(result)}\n${formatHumanSummary(result)}`;
  assert.doesNotMatch(rendered, /NEVER-OUTPUT/u);
  assert.equal(result.sections.github.environments.length, 4);
  assert.equal(result.sections.fly.apps.length, FLY_APP_VARIABLES.length);
  assert.equal(result.sections.supabase.authPolicy.status, "pass");
  assert.equal(result.sections.supabase.authPolicy.customSmtpConfigured, true);
});

test("authorization can run the GitHub authority audit without unrelated cloud credentials", async () => {
  const fixture = await validFixture();
  const result = await auditGithubReleaseAuthority({
    rootDirectory,
    repository,
    source: fixture.source,
    githubClient: fixture.githubClient,
    now: new Date("2026-08-04T00:00:00Z"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.sections), ["github"]);
  assert.match(formatHumanSummary(result), /GitHub release authority audit: PASS/u);
});

test("production audit fails closed on live Supabase Auth drift without disclosing SMTP metadata", async () => {
  const fixture = await validFixture();
  fixture.supabaseClient.authConfig = async () => ({
    ...validAuthConfig(),
    site_url: `${publicOrigin}/`,
    uri_allow_list: `${expectedSupabaseAuthRedirects(publicOrigin).join(",")},https://attacker.example/callback`,
    external_anonymous_users_enabled: true,
    password_hibp_enabled: false,
    smtp_user: "",
    ignored_secret: "NEVER-OUTPUT-AUTH-SECRET",
  });

  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
  });

  assert.equal(result.ok, false);
  const codes = new Set(result.findings.map(({ code }) => code));
  assert.ok(codes.has("supabase_auth_site_url_mismatch"));
  assert.ok(codes.has("supabase_auth_redirect_allow_list_mismatch"));
  assert.ok(codes.has("supabase_auth_anonymous_users_enabled"));
  assert.ok(codes.has("supabase_auth_leaked_password_protection_disabled"));
  assert.ok(codes.has("supabase_auth_custom_smtp_missing"));
  assert.doesNotMatch(`${JSON.stringify(result)}\n${formatHumanSummary(result)}`, /NEVER-OUTPUT/u);
});

test("Supabase Auth audit client uses the read-only Management API endpoint and projects no secret fields", async () => {
  const calls = [];
  const client = createSupabaseClient(
    async () => "[]",
    async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ...validAuthConfig(),
        smtp_pass: "NEVER-OUTPUT-SMTP-PASSWORD",
        unrelated_secret: "NEVER-OUTPUT-UNRELATED",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    { SUPABASE_MANAGEMENT_TOKEN: "management-token-canary" },
  );

  const config = await client.authConfig(projectRef);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.supabase.com/v1/projects/${projectRef}/config/auth`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.authorization, "Bearer management-token-canary");
  assert.equal(calls[0].init.redirect, "error");
  assert.doesNotMatch(JSON.stringify(config), /NEVER-OUTPUT|smtp_pass|unrelated_secret/u);
});

test("production audit binds its default Supabase client to the injected source", async () => {
  const fixture = await validFixture();
  let capturedSource = null;
  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClientFactory(_runner, _fetchImpl, source) {
      capturedSource = source;
      return fixture.supabaseClient;
    },
  });
  assert.equal(result.ok, true);
  assert.strictEqual(capturedSource, fixture.source);
});

test("production audit fails closed across every authority boundary", async () => {
  const fixture = await validFixture();
  fixture.environmentSecrets.production = fixture.environmentSecrets.production.filter(({ name }) => name !== "OPENAI_API_KEY");
  fixture.githubClient.classicBranchProtection = async () => ({
    statusChecks: ["verify"],
    requiredApprovingReviews: 0,
    strictStatusChecks: false,
    enforceAdmins: false,
  });
  fixture.githubClient.environment = async (_repository, name) => ({
    name,
    reviewers: [{ id: 7, login: "release-reviewers", type: "Team" }],
    preventSelfReview: false,
    canAdminsBypass: true,
    protectedBranches: false,
    customBranchPolicies: name === "dogfood-staging",
  });
  fixture.source.FLY_SEMANTIC_APP = fixture.source.FLY_SYNC_APP;
  fixture.supabaseClient.projects = async () => [{ ref: projectRef, region: "ap-northeast-1", status: "ACTIVE_HEALTHY" }];
  fixture.vercelInventory.runtimeNames.push("CONTROL_PLANE_DATABASE_URL");
  fixture.vercelInventory.runtimeNames = fixture.vercelInventory.runtimeNames.filter((name) => name !== "OPENAI_API_KEY");

  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
  });

  assert.equal(result.ok, false);
  const codes = new Set(result.findings.map(({ code }) => code));
  assert.ok(codes.has("github_environment_secrets_missing"));
  assert.ok(codes.has("github_required_checks_missing"));
  assert.ok(codes.has("github_code_review_missing"));
  assert.ok(codes.has("github_strict_status_checks_missing"));
  assert.ok(codes.has("github_admin_enforcement_missing"));
  assert.ok(codes.has("github_release_authority_tag_policy_missing"));
  assert.ok(codes.has("github_environment_self_review_allowed"));
  assert.ok(codes.has("github_environment_admin_bypass_allowed"));
  assert.ok(codes.has("fly_app_names_not_unique"));
  assert.ok(codes.has("supabase_control_plane_not_sydney"));
  assert.ok(codes.has("vercel_runtime_names_missing"));
  assert.ok(codes.has("vercel_forbidden_names_present"));
});

test("deployment environments reject broader branch and tag policy sets", async () => {
  const fixture = await validFixture();
  const exactPolicies = fixture.githubClient.deploymentPolicies;
  fixture.githubClient.deploymentPolicies = async (resolvedRepository, name) => {
    if (name === "production") {
      return [
        { name: "albert-release-authority-v*", type: "tag" },
        { name: "*", type: "tag" },
      ];
    }
    if (name === "dogfood-staging") return [{ name: "*", type: "tag" }];
    if (name === "vendor-attestor-trust") return [{ name: "vendor-attestor-v*", type: "branch" }];
    return exactPolicies(resolvedRepository, name);
  };

  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some(({ code, scope }) => (
    code === "github_release_authority_tag_policy_missing"
    && scope === "github.environment.production"
  )));
  assert.ok(result.findings.some(({ code, scope }) => (
    code === "github_release_authority_tag_policy_missing"
    && scope === "github.environment.dogfood-staging"
  )));
  assert.ok(result.findings.some(({ code, scope }) => (
    code === "github_vendor_attestor_tag_policy_missing"
    && scope === "github.environment.vendor-attestor-trust"
  )));
});

test("every protected environment rejects administrator approval bypass", async () => {
  const fixture = await validFixture();
  const exactEnvironment = fixture.githubClient.environment;
  fixture.githubClient.environment = async (resolvedRepository, name) => ({
    ...await exactEnvironment(resolvedRepository, name),
    canAdminsBypass: name === "staging-capacity",
  });
  const result = await auditGithubReleaseAuthority({
    rootDirectory,
    repository,
    source: fixture.source,
    githubClient: fixture.githubClient,
  });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(({ code, scope }) => (
    code === "github_environment_admin_bypass_allowed"
    && scope === "github.environment.staging-capacity"
  )));
});

test("ruleset-only main protection fails closed when administrator bypass safety is unproven", async () => {
  const fixture = await validFixture();
  fixture.githubClient.classicBranchProtection = async () => null;
  fixture.githubClient.branchRules = async () => [{
    statusChecks: fixture.requirements.requiredStatusChecks,
    strictStatusChecks: true,
    requiredApprovingReviews: 1,
  }];

  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some(({ code }) => code === "github_admin_enforcement_missing"));
});

test("non-running Fly application metadata fails the production audit", async () => {
  const fixture = await validFixture();
  fixture.apps.find(({ name }) => name === fixture.source.FLY_SEMANTIC_APP).status = "suspended";

  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some(({ code, scope }) => (
    code === "fly_app_unhealthy"
    && scope === "fly.app.FLY_SEMANTIC_APP"
  )));
});

test("production release runs only from immutable authority and keeps candidate checkout outside protected jobs", async () => {
  const release = loadYaml(await readFile(path.join(rootDirectory, ".github/workflows/release-authority.yml"), "utf8"));
  const verify = release.jobs["verify-candidate"];
  const build = release.jobs["build-candidate"];
  const cubeBuild = release.jobs["build-cube-candidate"];
  assert.equal(verify.environment, undefined);
  assert.equal(build.environment, undefined);
  assert.equal(cubeBuild.environment, undefined);
  assert.equal(build.permissions["id-token"], undefined);
  assert.equal(cubeBuild.permissions["id-token"], undefined);
  assert.equal(verify.permissions.packages, undefined);
  assert.ok(verify.steps.some(({ name }) => name === "Require the immutable signed release-authority tag"));
  const ciProof = verify.steps.find(({ name }) => (
    name === "Require one exact protected-main CI workflow run and check suite"
  ));
  assert.ok(ciProof);
  assert.match(ciProof.run, /test "\$ci_run_attempt" = 1/u);
  assert.ok(verify.steps.some(({ name }) => name === "Prove the candidate privileged surface before executing candidate code"));
  assert.equal(JSON.stringify(build).includes("npm run check"), false);
  assert.equal(JSON.stringify(cubeBuild).includes("npm run check"), false);
  assert.match(JSON.stringify(cubeBuild), /cube-playground\/Dockerfile/u);
  const cubeDeploy = release.jobs["deploy-services"].strategy.matrix.include.find(
    ({ service }) => service === "cube",
  );
  assert.deepEqual(cubeDeploy, {
    service: "cube",
    config: "deploy/fly/cube.toml",
    app_variable: "FLY_CUBE_APP",
    token_secret: "FLY_CUBE_API_TOKEN",
    exposure: "public",
  });
  const deployStep = release.jobs["deploy-services"].steps.find(
    ({ name }) => name === "Validate trusted config and deploy only the approved digest",
  );
  assert.match(
    deployStep.env.TARGET_FLOOR,
    /matrix\.service == 'cube' \|\| matrix\.service == 'codex-runtime'/u,
  );
  assert.match(deployStep.run, /matrix\.service \}\}" = cube[\s\S]*flyctl scale count 1/u);
  const cubeSmoke = release.jobs["activate-and-smoke"].steps.find(
    ({ name }) => name === "Prove Cube is live at the exact approved image and deployment",
  );
  assert.match(cubeSmoke.run, /select\(\.state == "started"\)\] \| length\) == 1/u);
  for (const [jobName, job] of Object.entries(release.jobs)) {
    assert.equal(job.if, "github.run_attempt == 1", `${jobName} must reject workflow reruns`);
    if (!job.environment) continue;
    const checkouts = job.steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    for (const checkout of checkouts) {
      assert.equal(checkout.with.ref, "${{ github.sha }}", `${jobName} must check out only authority tooling`);
      assert.equal(checkout.with["persist-credentials"], false, `${jobName} must not persist Git credentials`);
    }
    assert.equal(JSON.stringify(job).includes("working-directory: candidate"), false);
    assert.equal(JSON.stringify(job).includes("ref: ${{ inputs.candidate_sha }}"), false);
  }
});

test("dogfood producers share the immutable authority tag and reject workflow reruns", async () => {
  const workflowPaths = [
    ".github/workflows/dogfood-acceptance.yml",
    ".github/workflows/dogfood-onboarding-journey.yml",
  ];
  for (const workflowPath of workflowPaths) {
    const workflow = parseWorkflowYaml(
      await readFile(path.join(rootDirectory, workflowPath), "utf8"),
      workflowPath,
    );
    const [jobName] = Object.keys(workflow.jobs);
    const job = workflow.jobs[jobName];
    const serialized = JSON.stringify(job);
    const trustProof = job.steps.find(({ name }) => name?.startsWith("Verify trusted"));
    assert.ok(trustProof, `${workflowPath} must have an authority proof step`);
    assert.equal(job.if, "github.run_attempt == 1", `${workflowPath} must reject reruns`);
    assert.equal(job.environment, "dogfood-staging");
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.match(serialized, /GITHUB_EVENT_NAME/u);
    assert.match(serialized, /GITHUB_RUN_ATTEMPT/u);
    assert.match(serialized, /GITHUB_REF_TYPE/u);
    assert.match(serialized, /GITHUB_WORKFLOW_REF/u);
    assert.match(serialized, /albert-release-authority-v/u);
    assert.match(serialized, /repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags/u);
    assert.match(serialized, /verification\.verified/u);
    assert.match(serialized, /verification\.reason/u);
    assert.match(serialized, /tagger\.email/u);
    assert.match(trustProof.run, /test "\$GITHUB_REPOSITORY" = tomlidgett1\/Albert/u);
  }
});

test("legacy release dispatcher cannot select an environment, receive credentials, or execute a candidate", async () => {
  const legacy = parseWorkflowYaml(
    await readFile(path.join(rootDirectory, ".github/workflows/release.yml"), "utf8"),
    ".github/workflows/release.yml",
  );
  assert.deepEqual(Object.keys(legacy.jobs), ["retired"]);
  const serialized = JSON.stringify(legacy);
  assert.doesNotMatch(serialized, /secrets\.|environment|actions\/checkout@|inputs\./u);
  assert.equal(legacy.jobs.retired.permissions && Object.keys(legacy.jobs.retired.permissions).length, 0);
});

test("workflow YAML parser rejects duplicate keys instead of silently overriding authority", () => {
  assert.throws(
    () => parseWorkflowYaml("jobs:\n  release:\n    with: {a: 1}\n    with: {a: 2}\n", "duplicate.yml"),
    (error) => error.code === "invalid_workflow",
  );
});

test("release-authority tag rules fail closed if creation or immutability controls drift", async () => {
  const fixture = await validFixture();
  fixture.githubClient.releaseAuthorityRulesets = async () => [{
    id: 100,
    enforcement: "active",
    target: "tag",
    include: ["refs/tags/albert-release-authority-v*"],
    bypassActors: [{ actorId: 42, actorType: "Integration", bypassMode: "always" }],
    rules: ["creation", "update", "deletion"],
  }];
  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
  });
  const codes = new Set(result.findings.map(({ code }) => code));
  assert.ok(codes.has("github_release_authority_creation_ruleset_missing"));
  assert.ok(codes.has("github_release_authority_immutability_ruleset_missing"));
});

test("vendor-attestor trust requires split creation and no-bypass immutability rulesets", async () => {
  const fixture = await validFixture();
  const existing = await fixture.githubClient.releaseAuthorityRulesets();
  fixture.githubClient.releaseAuthorityRulesets = async () => [
    ...existing.filter(({ include }) => include?.[0] !== "refs/tags/vendor-attestor-v*"),
    {
      id: 200,
      enforcement: "active",
      target: "tag",
      include: ["refs/tags/vendor-attestor-v*"],
      bypassActors: [{ actorId: 43, actorType: "Integration", bypassMode: "always" }],
      rules: ["creation", "update", "deletion"],
    },
  ];
  const result = await auditProductionEnvironment({
    rootDirectory,
    repository,
    source: fixture.source,
    projectRef,
    vercelInventory: fixture.vercelInventory,
    githubClient: fixture.githubClient,
    flyClient: fixture.flyClient,
    supabaseClient: fixture.supabaseClient,
  });
  const codes = new Set(result.findings.map(({ code }) => code));
  assert.ok(codes.has("github_vendor_attestor_creation_ruleset_missing"));
  assert.ok(codes.has("github_vendor_attestor_immutability_ruleset_missing"));
});

test("tag ruleset audit fails closed when GitHub omits bypass-actor visibility", async () => {
  const fixture = await validFixture();
  const existing = await fixture.githubClient.releaseAuthorityRulesets();
  fixture.githubClient.releaseAuthorityRulesets = async () => existing.map((rule) => ({
    ...rule,
    bypassActorsPresent: rule.rules.includes("creation"),
  }));
  const result = await auditGithubReleaseAuthority({
    rootDirectory,
    repository,
    source: fixture.source,
    githubClient: fixture.githubClient,
  });
  const codes = new Set(result.findings.map(({ code }) => code));
  assert.ok(codes.has("github_release_authority_immutability_ruleset_missing"));
  assert.ok(codes.has("github_vendor_attestor_immutability_ruleset_missing"));
});

test("GitHub ruleset inventory distinguishes an exact empty bypass list from hidden metadata", async () => {
  const calls = [];
  const client = createGithubClient(async (command, args) => {
    calls.push({ command, args });
    if (args.some((argument) => argument.includes("rulesets?"))) return "[100]";
    return "{}";
  });
  await client.releaseAuthorityRulesets(repository);
  const detailCall = calls.find(({ args }) => args.includes(`repos/${repository}/rulesets/100?includes_parents=true`));
  assert.ok(detailCall);
  const jq = detailCall.args[detailCall.args.indexOf("--jq") + 1];
  assert.match(jq, /bypassActorsPresent:\(\.bypass_actors \| type == "array"\)/u);
});

test("GitHub variable inventory is projected server-side without values", async () => {
  const calls = [];
  const client = createGithubClient(async (command, args) => {
    calls.push({ command, args });
    return "[]";
  });
  await client.variables(repository, "production");
  const jq = calls[0].args[calls[0].args.indexOf("--jq") + 1];
  assert.doesNotMatch(jq, /\.value\b/u);
  assert.match(jq, /name:\.name/u);
  assert.ok(calls[0].args.includes("--paginate"));
  assert.ok(!calls[0].args.includes("--slurp"));
});

test("GitHub deployment-policy inventory paginates every policy as names-only records", async () => {
  const calls = [];
  const client = createGithubClient(async (command, args) => {
    calls.push({ command, args });
    return '{"name":"main","type":"branch"}\n';
  });
  assert.deepEqual(await client.deploymentPolicies(repository, "production"), [
    { name: "main", type: "branch" },
  ]);
  const jq = calls[0].args[calls[0].args.indexOf("--jq") + 1];
  assert.match(jq, /name:\.name/u);
  assert.doesNotMatch(jq, /\[[^\]]*branch_policies/u);
  assert.ok(calls[0].args.includes("--paginate"));
  assert.ok(!calls[0].args.includes("--slurp"));
});

test("GitHub environment inventory reads protected-branch state from the deployment policy object", async () => {
  const calls = [];
  const client = createGithubClient(async (command, args) => {
    calls.push({ command, args });
    return "{}";
  });
  await client.environment(repository, "production");
  const jq = calls[0].args[calls[0].args.indexOf("--jq") + 1];
  assert.match(jq, /deployment_branch_policy\.protected_branches/u);
  assert.match(jq, /deployment_branch_policy\.custom_branch_policies/u);
  assert.match(jq, /prevent_self_review/u);
  assert.match(jq, /can_admins_bypass/u);
});

test("Vercel inventory accepts names only and rejects assignments without echoing them", () => {
  const inventory = parseVercelInventoryNames([
    "project:prj_l5faWCnDWxw7QB7nBWgr9zaKFxuL",
    "team:team_wx7OlK7ikXNuFcOSaewRxonA",
    "runtime:OPENAI_API_KEY",
  ].join("\n"));
  assert.deepEqual(inventory.runtimeNames, ["OPENAI_API_KEY"]);
  const canary = "OPENAI_API_KEY=do-not-disclose-this-value";
  assert.throws(
    () => parseVercelInventoryNames(canary),
    (error) => error.code === "unsafe_vercel_inventory" && !error.message.includes("do-not-disclose"),
  );
});
