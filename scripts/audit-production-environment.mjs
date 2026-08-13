import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  evaluateSupabaseAuthProductionPolicy,
  fetchSupabaseAuthConfig,
} from "./supabase-auth-production-policy.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const VERCEL_PROJECT_PATTERN = /^prj_[A-Za-z0-9]{16,}$/u;
const VERCEL_TEAM_PATTERN = /^team_[A-Za-z0-9]{16,}$/u;
const FLY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const SYDNEY_REGION = "ap-southeast-2";
const DEFAULT_BRANCH = "main";
const RELEASE_AUTHORITY_TAG_PATTERN = "albert-release-authority-v*";
const RELEASE_AUTHORITY_TAG_INCLUDE = `refs/tags/${RELEASE_AUTHORITY_TAG_PATTERN}`;
const VENDOR_ATTESTOR_TAG_PATTERN = "vendor-attestor-v*";
const VENDOR_ATTESTOR_TAG_INCLUDE = `refs/tags/${VENDOR_ATTESTOR_TAG_PATTERN}`;
const HEALTHY_FLY_APP_STATUSES = new Set(["deployed", "running"]);
const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPTIONAL_RELEASE_NAMES = new Set([
  "ANALYTICAL_CAPABILITY_PREVIOUS_KEY_ID",
  "ANALYTICAL_CAPABILITY_PREVIOUS_RETIRE_AT",
]);
const RELEASE_ENVIRONMENTS = Object.freeze([
  Object.freeze({ name: "production", workflow: "authority", target: "production", reviewersRequired: true, branchPolicy: "authority-tag" }),
  Object.freeze({ name: "staging-capacity", workflow: "authority", target: "production", reviewersRequired: true, branchPolicy: "authority-tag" }),
  Object.freeze({ name: "dogfood-staging", workflow: "dogfood", target: "production", reviewersRequired: true, branchPolicy: "authority-tag" }),
  Object.freeze({ name: "vendor-attestor-trust", workflow: "vendor", target: "production", reviewersRequired: true, branchPolicy: "vendor-tag" }),
]);

export const FLY_APP_VARIABLES = Object.freeze([
  "FLY_ANTHROPIC_APP",
  "FLY_SEMANTIC_APP",
  "FLY_CUBE_APP",
  "FLY_SYNC_APP",
  "FLY_TRANSFORM_APP",
  "FLY_WEBHOOK_APP",
  "FLY_DELETION_APP",
  "FLY_OPERATOR_DIAGNOSTIC_APP",
  "FLY_SYNC_AUTOSCALER_APP",
  "FLY_TRANSFORM_AUTOSCALER_APP",
  "FLY_VENDOR_ATTESTOR_APP",
]);

class SafeAuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafeAuditError";
    this.code = code;
  }
}

function safeFailure(code, message) {
  return new SafeAuditError(code, message);
}

export async function safeCommandRunner(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: ROOT_DIRECTORY,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw safeFailure("external_command_failed", `${command} metadata inspection failed.`);
  }
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw safeFailure("invalid_metadata_response", `${label} returned invalid metadata.`);
  }
}

function parseJsonLines(output, label) {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    throw safeFailure("invalid_metadata_response", `${label} returned invalid metadata.`);
  }
}

function collectReferences(fragment, matrixRows, result) {
  if (fragment === null || fragment === undefined) return;
  if (Array.isArray(fragment)) {
    for (const value of fragment) collectReferences(value, matrixRows, result);
    return;
  }
  if (typeof fragment === "object") {
    for (const value of Object.values(fragment)) collectReferences(value, matrixRows, result);
    return;
  }
  if (typeof fragment !== "string") return;

  for (const match of fragment.matchAll(/\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/gu)) {
    result.secrets.add(match[1]);
  }
  for (const match of fragment.matchAll(/\$\{\{\s*vars\.([A-Z][A-Z0-9_]*)\s*\}\}/gu)) {
    result.variables.add(match[1]);
  }
  for (const match of fragment.matchAll(/\b(secrets|vars)\[matrix\.([A-Za-z0-9_]+)\]/gu)) {
    const destination = match[1] === "secrets" ? result.secrets : result.variables;
    for (const row of matrixRows) {
      const value = row?.[match[2]];
      if (typeof value === "string" && ENVIRONMENT_NAME_PATTERN.test(value)) destination.add(value);
    }
  }
}

function conditionApplies(condition, target) {
  if (typeof condition !== "string") return true;
  const normalized = condition.trim().replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, "");
  const equals = /^inputs\.environment\s*==\s*['"](staging|production)['"]$/u.exec(normalized);
  if (equals) return equals[1] === target;
  const notEquals = /^inputs\.environment\s*!=\s*['"](staging|production)['"]$/u.exec(normalized);
  if (notEquals) return notEquals[1] !== target;
  return true;
}

function jobEnvironment(job, target) {
  const environment = typeof job.environment === "object" ? job.environment?.name : job.environment;
  if (typeof environment !== "string") return null;
  return environment.includes("inputs.environment") ? target : environment;
}

export function deriveEnvironmentRequirements(workflow, environmentName, target = "production") {
  const result = { secrets: new Set(), variables: new Set() };
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw safeFailure("invalid_workflow", "GitHub workflow has no jobs metadata.");
  }

  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    if (jobEnvironment(job, target) !== environmentName || !conditionApplies(job.if, target)) continue;
    const matrixRows = Array.isArray(job.strategy?.matrix?.include) ? job.strategy.matrix.include : [];
    const steps = job.steps ?? [];
    const jobMetadata = { ...job };
    delete jobMetadata.steps;
    delete jobMetadata.strategy;
    delete jobMetadata.environment;
    delete jobMetadata.if;
    collectReferences(jobMetadata, matrixRows, result);
    for (const step of Array.isArray(steps) ? steps : []) {
      if (conditionApplies(step?.if, target)) collectReferences(step, matrixRows, result);
    }
  }

  return Object.freeze({
    secrets: Object.freeze([...result.secrets].sort()),
    variables: Object.freeze([...result.variables].sort()),
  });
}

export function parseWorkflowYaml(body, label = "GitHub workflow") {
  try {
    const workflow = loadYaml(body, { filename: label, json: false });
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      throw new Error("workflow root is not a mapping");
    }
    return workflow;
  } catch {
    throw safeFailure("invalid_workflow", `${label} is invalid or contains duplicate mapping keys.`);
  }
}

function assertLegacyReleaseDisabled(workflow) {
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs) ||
      Object.keys(jobs).length !== 1 || !jobs.retired) {
    throw safeFailure("legacy_release_enabled", "Legacy release workflow must contain only its retired fail-closed job.");
  }
  const serialized = JSON.stringify(workflow);
  if (serialized.includes("secrets.") || serialized.includes("environment") ||
      serialized.includes("actions/checkout@") || serialized.includes("inputs.")) {
    throw safeFailure("legacy_release_enabled", "Legacy release workflow regained a credential, checkout, environment, or input surface.");
  }
}

export async function loadProductionRequirements(rootDirectory = ROOT_DIRECTORY) {
  const [releaseBody, authorityBody, semanticV2Body, dogfoodBody, dogfoodOnboardingBody, vendorBody, ciBody] = await Promise.all([
    readFile(path.join(rootDirectory, ".github/workflows/release.yml"), "utf8"),
    readFile(path.join(rootDirectory, ".github/workflows/release-authority.yml"), "utf8"),
    readFile(path.join(rootDirectory, ".github/workflows/semantic-v2-production.yml"), "utf8"),
    readFile(path.join(rootDirectory, ".github/workflows/dogfood-acceptance.yml"), "utf8"),
    readFile(path.join(rootDirectory, ".github/workflows/dogfood-onboarding-journey.yml"), "utf8"),
    readFile(path.join(rootDirectory, ".github/workflows/vendor-connection-attestor.yml"), "utf8"),
    readFile(path.join(rootDirectory, ".github/workflows/ci.yml"), "utf8"),
  ]);
  const release = parseWorkflowYaml(releaseBody, ".github/workflows/release.yml");
  const authority = parseWorkflowYaml(authorityBody, ".github/workflows/release-authority.yml");
  const semanticV2 = parseWorkflowYaml(semanticV2Body, ".github/workflows/semantic-v2-production.yml");
  const dogfood = parseWorkflowYaml(dogfoodBody, ".github/workflows/dogfood-acceptance.yml");
  const dogfoodOnboarding = parseWorkflowYaml(
    dogfoodOnboardingBody,
    ".github/workflows/dogfood-onboarding-journey.yml",
  );
  const vendor = parseWorkflowYaml(vendorBody, ".github/workflows/vendor-connection-attestor.yml");
  const ci = parseWorkflowYaml(ciBody, ".github/workflows/ci.yml");
  assertLegacyReleaseDisabled(release);
  const environments = Object.fromEntries(RELEASE_ENVIRONMENTS.map((entry) => {
    const workflows = entry.workflow === "authority"
      ? entry.name === "production"
        ? [authority, semanticV2]
        : [authority]
      : entry.workflow === "dogfood" ? [dogfood, dogfoodOnboarding] : [vendor];
    const derived = workflows.map((workflow) => (
      deriveEnvironmentRequirements(workflow, entry.name, entry.target)
    ));
    const secrets = [...new Set(derived.flatMap((requirement) => requirement.secrets))].sort();
    const variables = [...new Set(derived.flatMap((requirement) => requirement.variables))].sort();
    const requiredName = (name) => !OPTIONAL_RELEASE_NAMES.has(name);
    return [entry.name, {
      ...entry,
      secrets: Object.freeze(secrets.filter(requiredName)),
      variables: Object.freeze(variables.filter(requiredName)),
    }];
  }));
  const requiredStatusChecks = Object.keys(ci?.jobs ?? {}).sort();
  if (requiredStatusChecks.length === 0) {
    throw safeFailure("invalid_workflow", "CI workflow has no status-check jobs.");
  }
  return Object.freeze({ environments: Object.freeze(environments), requiredStatusChecks: Object.freeze(requiredStatusChecks) });
}

function normalizeTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function inventoryMetadata(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === "object" && ENVIRONMENT_NAME_PATTERN.test(item.name ?? ""))
    .map((item) => ({
      name: item.name,
      createdAt: normalizeTimestamp(item.createdAt ?? item.created_at),
      updatedAt: normalizeTimestamp(item.updatedAt ?? item.updated_at),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createGithubClient(runner = safeCommandRunner) {
  const header = ["-H", "X-GitHub-Api-Version: 2022-11-28"];
  const api = async (endpoint, jq, { paginate = false, optional = false, ndjson = false } = {}) => {
    const args = ["api", "--method", "GET", ...header];
    if (paginate) args.push("--paginate");
    args.push(endpoint, "--jq", jq);
    try {
      const output = await runner("gh", args);
      return ndjson ? parseJsonLines(output, "GitHub") : parseJsonOutput(output, "GitHub");
    } catch (error) {
      if (optional) return null;
      throw error;
    }
  };

  return Object.freeze({
    async repository(explicitRepository) {
      if (explicitRepository) return explicitRepository;
      const output = await runner("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
      return output.trim();
    },
    async verifyAuthentication() {
      await api("user", "{authenticated:true}");
      return true;
    },
    environment(repository, name) {
      return api(
        `repos/${repository}/environments/${encodeURIComponent(name)}`,
        "{name:.name,canAdminsBypass:(.can_admins_bypass // true),protectedBranches:(.deployment_branch_policy.protected_branches // false),customBranchPolicies:(.deployment_branch_policy.custom_branch_policies // false),preventSelfReview:([.protection_rules[]? | select(.type == \"required_reviewers\") | .prevent_self_review] | first // false),reviewers:([.protection_rules[]? | select(.type == \"required_reviewers\") | .reviewers[]? | {id:(.reviewer.id // null),login:(.reviewer.login // .reviewer.slug // null),type:(.type // .reviewer.type // null)}]),waitTimerMinutes:([.protection_rules[]? | select(.type == \"wait_timer\") | .wait_timer] | first // 0)}",
      );
    },
    secrets(repository, name) {
      return api(
        `repos/${repository}/environments/${encodeURIComponent(name)}/secrets?per_page=100`,
        ".secrets[] | {name:.name,createdAt:.created_at,updatedAt:.updated_at}",
        { paginate: true, ndjson: true },
      );
    },
    variables(repository, name) {
      return api(
        `repos/${repository}/environments/${encodeURIComponent(name)}/variables?per_page=100`,
        ".variables[] | {name:.name,createdAt:.created_at,updatedAt:.updated_at}",
        { paginate: true, ndjson: true },
      );
    },
    deploymentPolicies(repository, name) {
      return api(
        `repos/${repository}/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100`,
        ".branch_policies[]? | {name:.name,type:(.type // \"branch\")}",
        { paginate: true, optional: true, ndjson: true },
      );
    },
    classicBranchProtection(repository, branch) {
      return api(
        `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
        "{statusChecks:(.required_status_checks.contexts // []),strictStatusChecks:(.required_status_checks.strict // false),requiredApprovingReviews:(.required_pull_request_reviews.required_approving_review_count // 0),dismissStaleReviews:(.required_pull_request_reviews.dismiss_stale_reviews // false),enforceAdmins:(.enforce_admins.enabled // false)}",
        { optional: true },
      );
    },
    branchRules(repository, branch) {
      return api(
        `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`,
        "[.[] | {type:.type,statusChecks:(if .type == \"required_status_checks\" then [.parameters.required_status_checks[]?.context] else [] end),strictStatusChecks:(if .type == \"required_status_checks\" then (.parameters.strict_required_status_checks_policy // false) else false end),requiredApprovingReviews:(if .type == \"pull_request\" then (.parameters.required_approving_review_count // 0) else 0 end)}]",
        { optional: true },
      );
    },
    async releaseAuthorityRulesets(repository) {
      const ids = await api(
        `repos/${repository}/rulesets?includes_parents=true&per_page=100`,
        "[.[] | .id]",
        { optional: true },
      );
      if (!Array.isArray(ids)) return [];
      return Promise.all(ids.map((id) => api(
        `repos/${repository}/rulesets/${id}?includes_parents=true`,
        "{id:.id,name:.name,enforcement:.enforcement,target:.target,include:(.conditions.ref_name.include // []),exclude:(.conditions.ref_name.exclude // []),bypassActorsPresent:(.bypass_actors | type == \"array\"),bypassActors:[.bypass_actors[]? | {actorId:.actor_id,actorType:.actor_type,bypassMode:.bypass_mode}],rules:[.rules[]?.type]}",
        { optional: true },
      ))).then((rows) => rows.filter(Boolean));
    },
  });
}

export function createFlyClient(runner = safeCommandRunner) {
  return Object.freeze({
    async verifyAuthentication() {
      await runner("flyctl", ["auth", "whoami", "--json"]);
      return true;
    },
    async apps(organization) {
      const args = ["apps", "list", "--json"];
      if (organization) args.push("--org", organization);
      const response = parseJsonOutput(await runner("flyctl", args), "Fly");
      const rows = Array.isArray(response) ? response : response?.apps;
      if (!Array.isArray(rows)) throw safeFailure("invalid_metadata_response", "Fly returned invalid app metadata.");
      return rows.map((item) => ({
        name: item?.Name ?? item?.name ?? null,
        organization: item?.Organization?.Slug ?? item?.organization?.slug ?? item?.Owner?.Slug ?? item?.owner?.slug ?? item?.Organization ?? item?.organization ?? null,
        status: item?.Status ?? item?.status ?? null,
      }));
    },
  });
}

export function createSupabaseClient(
  runner = safeCommandRunner,
  fetchImpl = fetch,
  source = process.env,
) {
  return Object.freeze({
    async projects() {
      const response = parseJsonOutput(
        await runner("supabase", ["projects", "list", "--output", "json"]),
        "Supabase",
      );
      if (!Array.isArray(response)) throw safeFailure("invalid_metadata_response", "Supabase returned invalid project metadata.");
      return response.map((item) => ({
        ref: item?.ref ?? item?.id ?? item?.reference_id ?? null,
        region: item?.region ?? null,
        status: item?.status ?? null,
      }));
    },
    async authConfig(projectRef) {
      try {
        return await fetchSupabaseAuthConfig({
          projectRef,
          token: source.SUPABASE_MANAGEMENT_TOKEN,
          fetchImpl,
        });
      } catch {
        throw safeFailure(
          "supabase_auth_config_unavailable",
          "Supabase Auth configuration metadata is unavailable.",
        );
      }
    },
  });
}

export function parseVercelInventoryNames(body) {
  const inventory = {
    projectId: null,
    teamId: null,
    runtimeNames: new Set(),
  };
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("=")) {
      throw safeFailure("unsafe_vercel_inventory", "Vercel inventory must contain names only; assignments are forbidden.");
    }
    const separator = line.indexOf(":");
    if (separator < 1 || line.indexOf(":", separator + 1) !== -1) {
      throw safeFailure("invalid_vercel_inventory", "Vercel inventory contains an invalid names-only record.");
    }
    const kind = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (kind === "project" && VERCEL_PROJECT_PATTERN.test(name)) {
      if (inventory.projectId && inventory.projectId !== name) {
        throw safeFailure("invalid_vercel_inventory", "Vercel inventory names more than one project.");
      }
      inventory.projectId = name;
    } else if (kind === "team" && VERCEL_TEAM_PATTERN.test(name)) {
      if (inventory.teamId && inventory.teamId !== name) {
        throw safeFailure("invalid_vercel_inventory", "Vercel inventory names more than one team.");
      }
      inventory.teamId = name;
    } else if (kind === "runtime" && ENVIRONMENT_NAME_PATTERN.test(name)) {
      inventory.runtimeNames.add(name);
    } else {
      throw safeFailure("invalid_vercel_inventory", "Vercel inventory contains an invalid names-only record.");
    }
  }
  return Object.freeze({
    projectId: inventory.projectId,
    teamId: inventory.teamId,
    runtimeNames: Object.freeze([...inventory.runtimeNames].sort()),
  });
}

function addFinding(findings, code, scope, message) {
  findings.push(Object.freeze({ code, scope, message }));
}

function checkMatches(context, expected) {
  return context === expected || context.endsWith(` / ${expected}`);
}

function hasOnlyExactDeploymentPolicy(policies, expected) {
  return policies.length === 1
    && policies[0]?.name === expected.name
    && policies[0]?.type === expected.type;
}

function auditImmutableTagNamespace({
  rulesets,
  include,
  expectedIssuerAppId,
  codePrefix,
  scopePrefix,
  label,
}, findings) {
  const exactNamespace = rulesets.filter((rule) =>
    rule?.target === "tag" && rule?.enforcement === "active" &&
    Array.isArray(rule.include) && rule.include.length === 1 && rule.include[0] === include &&
    (!Array.isArray(rule.exclude) || rule.exclude.length === 0));
  const creationRules = exactNamespace.filter((rule) =>
    Array.isArray(rule.rules) && rule.rules.length === 1 && rule.rules[0] === "creation");
  const immutableRules = exactNamespace.filter((rule) =>
    Array.isArray(rule.rules) && rule.rules.length === 2 && new Set(rule.rules).size === 2 &&
    rule.rules.includes("update") && rule.rules.includes("deletion"));
  const expectedIssuerId = String(expectedIssuerAppId ?? "").trim();
  if (!/^[1-9][0-9]{0,19}$/u.test(expectedIssuerId)) {
    addFinding(findings, `${codePrefix}_issuer_app_id_missing`, `${scopePrefix}.creation`,
      `The expected ${label} issuer GitHub App ID is missing or invalid.`);
  }
  const creationBypasses = Array.isArray(creationRules[0]?.bypassActors)
    ? creationRules[0].bypassActors : [];
  if (creationRules.length !== 1 || creationRules[0]?.bypassActorsPresent !== true ||
      creationBypasses.length !== 1 ||
      creationBypasses[0]?.actorType !== "Integration" || creationBypasses[0]?.bypassMode !== "always" ||
      String(creationBypasses[0]?.actorId ?? "") !== expectedIssuerId) {
    addFinding(findings, `${codePrefix}_creation_ruleset_missing`, `${scopePrefix}.creation`,
      `${label} tags require one active creation-only ruleset with only the exact issuer GitHub App bypass.`);
  }
  const immutableBypasses = Array.isArray(immutableRules[0]?.bypassActors)
    ? immutableRules[0].bypassActors : [];
  if (immutableRules.length !== 1 || immutableRules[0]?.bypassActorsPresent !== true ||
      immutableBypasses.length !== 0) {
    addFinding(findings, `${codePrefix}_immutability_ruleset_missing`, `${scopePrefix}.immutable`,
      `${label} tags require one independent update/deletion ruleset with no bypass actors, including administrators.`);
  }
}

async function auditGithub({
  client,
  repository,
  requirements,
  findings,
  expectedCreatorAppId,
  expectedVendorIssuerAppId,
}) {
  const section = { status: "fail", authenticated: false, repository: repository ?? null, environments: [], branchProtection: null };
  try {
    const resolvedRepository = await client.repository(repository);
    if (!REPOSITORY_PATTERN.test(resolvedRepository)) {
      addFinding(findings, "github_repository_invalid", "github", "GitHub repository metadata is invalid.");
      return section;
    }
    section.repository = resolvedRepository;
    section.authenticated = await client.verifyAuthentication();
    for (const specification of RELEASE_ENVIRONMENTS) {
      const required = requirements.environments[specification.name];
      try {
        const [metadata, rawSecrets, rawVariables, policies] = await Promise.all([
          client.environment(resolvedRepository, specification.name),
          client.secrets(resolvedRepository, specification.name),
          client.variables(resolvedRepository, specification.name),
          client.deploymentPolicies(resolvedRepository, specification.name),
        ]);
        const secrets = inventoryMetadata(rawSecrets);
        const variables = inventoryMetadata(rawVariables);
        const secretNames = new Set(secrets.map(({ name }) => name));
        const variableNames = new Set(variables.map(({ name }) => name));
        const missingSecrets = required.secrets.filter((name) => !secretNames.has(name));
        const missingVariables = required.variables.filter((name) => !variableNames.has(name));
        if (missingSecrets.length > 0) {
          addFinding(findings, "github_environment_secrets_missing", `github.environment.${specification.name}`, `Missing required secret names: ${missingSecrets.join(", ")}.`);
        }
        if (missingVariables.length > 0) {
          addFinding(findings, "github_environment_variables_missing", `github.environment.${specification.name}`, `Missing required variable names: ${missingVariables.join(", ")}.`);
        }
        const reviewers = Array.isArray(metadata?.reviewers)
          ? metadata.reviewers.filter((reviewer) => reviewer &&
              Number.isInteger(Number(reviewer.id)) && Number(reviewer.id) > 0 &&
              typeof reviewer.login === "string" && reviewer.login.length > 0 &&
              (reviewer.type === "User" || reviewer.type === "Team"))
            .map((reviewer) => ({ id: String(reviewer.id), login: reviewer.login, type: reviewer.type }))
          : [];
        const reviewerCount = reviewers.length;
        if (specification.reviewersRequired && (!Number.isInteger(reviewerCount) || reviewerCount < 1)) {
          addFinding(findings, "github_environment_reviewers_missing", `github.environment.${specification.name}`, "The protected environment has no required reviewer.");
        }
        if (specification.reviewersRequired && metadata?.preventSelfReview !== true) {
          addFinding(findings, "github_environment_self_review_allowed", `github.environment.${specification.name}`,
            "The protected environment must prevent a dispatcher from approving their own run.");
        }
        if (metadata?.canAdminsBypass !== false) {
          addFinding(findings, "github_environment_admin_bypass_allowed", `github.environment.${specification.name}`,
            "The protected environment must disable administrator bypass of deployment protection rules.");
        }
        const normalizedPolicies = Array.isArray(policies)
          ? policies.filter((policy) => policy && typeof policy.name === "string").map((policy) => ({
              name: policy.name,
              type: policy.type === "tag" || policy.type === "branch" ? policy.type : "unknown",
            }))
          : [];
        if (
          specification.branchPolicy === "main"
          && (
            metadata?.protectedBranches === true
            || metadata?.customBranchPolicies !== true
            || !hasOnlyExactDeploymentPolicy(normalizedPolicies, { name: DEFAULT_BRANCH, type: "branch" })
          )
        ) {
          addFinding(findings, "github_environment_branch_policy_missing", `github.environment.${specification.name}`, "The environment must allow deployments from only the exact main branch.");
        }
        if (specification.branchPolicy === "authority-tag") {
          if (
            metadata?.protectedBranches === true
            || metadata?.customBranchPolicies !== true
            || !hasOnlyExactDeploymentPolicy(normalizedPolicies, { name: RELEASE_AUTHORITY_TAG_PATTERN, type: "tag" })
          ) {
            addFinding(findings, "github_release_authority_tag_policy_missing", `github.environment.${specification.name}`, `Production authority must allow only the exact ${RELEASE_AUTHORITY_TAG_PATTERN} tag policy.`);
          }
        }
        if (specification.branchPolicy === "vendor-tag") {
          if (
            metadata?.protectedBranches === true
            || metadata?.customBranchPolicies !== true
            || !hasOnlyExactDeploymentPolicy(normalizedPolicies, { name: VENDOR_ATTESTOR_TAG_PATTERN, type: "tag" })
          ) {
            addFinding(findings, "github_vendor_attestor_tag_policy_missing",
              `github.environment.${specification.name}`,
              `Vendor attestor trust must allow only the exact ${VENDOR_ATTESTOR_TAG_PATTERN} tag policy.`);
          }
        }
        section.environments.push({
          name: specification.name,
          exists: true,
          reviewerCount,
          preventSelfReview: metadata?.preventSelfReview === true,
          canAdminsBypass: metadata?.canAdminsBypass !== false,
          reviewers,
          protectedBranches: metadata?.protectedBranches === true,
          customBranchPolicies: metadata?.customBranchPolicies === true,
          deploymentPolicies: normalizedPolicies,
          requiredSecretNames: required.secrets,
          requiredVariableNames: required.variables,
          secretInventory: secrets,
          variableInventory: variables,
          missingSecretNames: missingSecrets,
          missingVariableNames: missingVariables,
        });
      } catch {
        addFinding(findings, "github_environment_unavailable", `github.environment.${specification.name}`, "Protected environment metadata is unavailable.");
        section.environments.push({ name: specification.name, exists: false });
      }
    }

    const [classic, rules, releaseAuthorityRulesets] = await Promise.all([
      client.classicBranchProtection(resolvedRepository, DEFAULT_BRANCH),
      client.branchRules(resolvedRepository, DEFAULT_BRANCH),
      client.releaseAuthorityRulesets(resolvedRepository),
    ]);
    const ruleRows = Array.isArray(rules) ? rules : [];
    const statusChecks = new Set([
      ...(Array.isArray(classic?.statusChecks) ? classic.statusChecks : []),
      ...ruleRows.flatMap((rule) => Array.isArray(rule?.statusChecks) ? rule.statusChecks : []),
    ].filter((value) => typeof value === "string"));
    const requiredApprovingReviews = Math.max(
      Number(classic?.requiredApprovingReviews ?? 0),
      ...ruleRows.map((rule) => Number(rule?.requiredApprovingReviews ?? 0)),
    );
    const missingStatusChecks = requirements.requiredStatusChecks.filter(
      (expected) => ![...statusChecks].some((context) => checkMatches(context, expected)),
    );
    const protectionExists = classic !== null || ruleRows.length > 0;
    if (!protectionExists) addFinding(findings, "github_branch_unprotected", "github.branch.main", "No active main-branch protection metadata is available.");
    if (missingStatusChecks.length > 0) {
      addFinding(findings, "github_required_checks_missing", "github.branch.main", `Missing required CI checks: ${missingStatusChecks.join(", ")}.`);
    }
    if (!Number.isFinite(requiredApprovingReviews) || requiredApprovingReviews < 1) {
      addFinding(findings, "github_code_review_missing", "github.branch.main", "Main does not require an approving pull-request review.");
    }
    const strictStatusChecks = classic?.strictStatusChecks === true ||
      ruleRows.some((rule) => rule?.strictStatusChecks === true);
    if (!strictStatusChecks) {
      addFinding(findings, "github_strict_status_checks_missing", "github.branch.main", "Main does not require the branch to be current before required checks pass.");
    }
    if (classic?.enforceAdmins !== true) {
      addFinding(findings, "github_admin_enforcement_missing", "github.branch.main", "Classic main-branch protection with administrator enforcement is required; active branch-rule metadata alone cannot prove bypass safety.");
    }
    section.branchProtection = {
      branch: DEFAULT_BRANCH,
      sources: [classic !== null ? "classic" : null, ruleRows.length > 0 ? "rulesets" : null].filter(Boolean),
      requiredStatusChecks: [...statusChecks].sort(),
      expectedStatusChecks: requirements.requiredStatusChecks,
      missingStatusChecks,
      requiredApprovingReviews,
      strictStatusChecks,
      enforceAdmins: classic?.enforceAdmins === true,
    };
    const authorityRules = Array.isArray(releaseAuthorityRulesets) ? releaseAuthorityRulesets : [];
    auditImmutableTagNamespace({
      rulesets: authorityRules,
      include: RELEASE_AUTHORITY_TAG_INCLUDE,
      expectedIssuerAppId: expectedCreatorAppId,
      codePrefix: "github_release_authority",
      scopePrefix: "github.ruleset.release-authority",
      label: "Release-authority",
    }, findings);
    auditImmutableTagNamespace({
      rulesets: authorityRules,
      include: VENDOR_ATTESTOR_TAG_INCLUDE,
      expectedIssuerAppId: expectedVendorIssuerAppId,
      codePrefix: "github_vendor_attestor",
      scopePrefix: "github.ruleset.vendor-attestor",
      label: "Vendor-attestor authority",
    }, findings);
    section.tagRulesets = authorityRules;
  } catch {
    addFinding(findings, "github_authority_unavailable", "github", "GitHub authentication or repository metadata is unavailable.");
  }
  section.status = findings.some(({ scope }) => scope === "github" || scope.startsWith("github.")) ? "fail" : "pass";
  return section;
}

async function auditFly({ client, source, findings }) {
  const section = { status: "fail", authenticated: false, organization: null, apps: [] };
  const organization = source.FLY_ORGANIZATION_SLUG?.trim() ?? "";
  const configuredApps = FLY_APP_VARIABLES.map((variable) => ({ variable, name: source[variable]?.trim() ?? "" }));
  section.organization = organization || null;
  for (const { variable, name } of configuredApps) {
    if (!name || !FLY_NAME_PATTERN.test(name)) addFinding(findings, "fly_app_name_missing", `fly.app.${variable}`, `${variable} does not name a valid Fly app.`);
  }
  if (!organization || !FLY_NAME_PATTERN.test(organization)) {
    addFinding(findings, "fly_organization_missing", "fly", "FLY_ORGANIZATION_SLUG does not name a valid Fly organization.");
  }
  const namedApps = configuredApps.filter(({ name }) => FLY_NAME_PATTERN.test(name));
  if (new Set(namedApps.map(({ name }) => name)).size !== namedApps.length) {
    addFinding(findings, "fly_app_names_not_unique", "fly", "Fly runtime and autoscaler app names must be unique.");
  }
  try {
    section.authenticated = await client.verifyAuthentication();
    const accessible = await client.apps(organization || undefined);
    for (const configured of namedApps) {
      const match = accessible.find(({ name }) => name === configured.name);
      if (!match) {
        addFinding(findings, "fly_app_unavailable", `fly.app.${configured.variable}`, `${configured.variable} app metadata is unavailable to the authenticated Fly identity.`);
        section.apps.push({ ...configured, accessible: false });
        continue;
      }
      const appOrganization = typeof match.organization === "string" ? match.organization : null;
      if (organization && appOrganization && appOrganization !== organization) {
        addFinding(findings, "fly_app_organization_mismatch", `fly.app.${configured.variable}`, `${configured.variable} belongs to a different Fly organization.`);
      }
      const appStatus = typeof match.status === "string" ? match.status.trim().toLowerCase() : "";
      if (!HEALTHY_FLY_APP_STATUSES.has(appStatus)) {
        addFinding(findings, "fly_app_unhealthy", `fly.app.${configured.variable}`, `${configured.variable} is not in a running or deployed state.`);
      }
      section.apps.push({
        ...configured,
        accessible: true,
        organization: appOrganization,
        status: appStatus || null,
      });
    }
  } catch {
    addFinding(findings, "fly_authority_unavailable", "fly", "Fly authentication or app metadata is unavailable.");
  }
  section.status = findings.some(({ scope }) => scope === "fly" || scope.startsWith("fly.")) ? "fail" : "pass";
  return section;
}

async function auditSupabase({ client, projectRef, publicOrigin, findings }) {
  const section = {
    status: "fail",
    projectRef: projectRef || null,
    region: null,
    projectStatus: null,
    authPolicy: null,
  };
  if (!PROJECT_REF_PATTERN.test(projectRef ?? "")) {
    addFinding(findings, "supabase_project_ref_missing", "supabase", "A valid control-plane Supabase project ref is required.");
    return section;
  }
  try {
    const projects = await client.projects();
    const project = projects.find(({ ref }) => ref === projectRef);
    if (!project) {
      addFinding(findings, "supabase_project_unavailable", "supabase", "The selected control-plane project is unavailable to the authenticated Supabase identity.");
      return section;
    }
    section.region = typeof project.region === "string" ? project.region : null;
    section.projectStatus = typeof project.status === "string" ? project.status : null;
    if (project.region !== SYDNEY_REGION) {
      addFinding(findings, "supabase_control_plane_not_sydney", "supabase", `The selected control-plane project is not in ${SYDNEY_REGION}.`);
    }
    if (project.status !== "ACTIVE_HEALTHY") {
      addFinding(findings, "supabase_control_plane_unhealthy", "supabase", "The selected control-plane project is not ACTIVE_HEALTHY.");
    }
  } catch {
    addFinding(findings, "supabase_authority_unavailable", "supabase", "Supabase authentication or project metadata is unavailable.");
  }
  try {
    const authConfig = await client.authConfig(projectRef);
    const policy = evaluateSupabaseAuthProductionPolicy(authConfig, publicOrigin);
    section.authPolicy = {
      status: policy.ok ? "pass" : "fail",
      expectedRedirectCount: policy.expectedRedirectCount,
      ...policy.checks,
    };
    for (const { code, message } of policy.violations) {
      addFinding(findings, code, "supabase.auth", message);
    }
  } catch {
    addFinding(
      findings,
      "supabase_auth_config_unavailable",
      "supabase.auth",
      "Supabase Auth configuration or ALBERT_PUBLIC_ORIGIN is unavailable or invalid.",
    );
  }
  section.status = findings.some(({ scope }) => scope === "supabase" || scope.startsWith("supabase.")) ? "fail" : "pass";
  return section;
}

async function auditVercel({ rootDirectory, inventory, findings }) {
  const section = {
    status: "fail",
    projectId: null,
    teamId: null,
    staticContract: null,
    runtimeInventory: inventory ?? null,
  };
  try {
    const [projectBody, vercelBody, runtimeBody] = await Promise.all([
      readFile(path.join(rootDirectory, "deploy/vercel-project.json"), "utf8"),
      readFile(path.join(rootDirectory, "vercel.json"), "utf8"),
      readFile(path.join(rootDirectory, "deploy/runtime-contract.json"), "utf8"),
    ]);
    const project = JSON.parse(projectBody);
    const vercel = JSON.parse(vercelBody);
    const runtimeContract = JSON.parse(runtimeBody);
    const web = runtimeContract?.runtimes?.web;
    if (
      !VERCEL_PROJECT_PATTERN.test(project?.projectId ?? "") ||
      !VERCEL_TEAM_PATTERN.test(project?.teamId ?? "") ||
      project?.productionBranch !== "main" ||
      vercel?.framework !== "nextjs" ||
      vercel?.buildCommand !== "next build --webpack" ||
      vercel?.installCommand !== "npm ci" ||
      web?.platform !== "vercel" ||
      web?.manifest !== "vercel.json" ||
      web?.project !== "deploy/vercel-project.json"
    ) {
      addFinding(findings, "vercel_static_contract_invalid", "vercel", "Vercel project or web runtime metadata is invalid.");
      return section;
    }
    const requiredRuntimeNames = Array.isArray(web.requiredRuntimeValues) ? [...web.requiredRuntimeValues].sort() : [];
    const optionalRuntimeNames = Array.isArray(web.optionalRuntimeValues) ? [...web.optionalRuntimeValues].sort() : [];
    const forbiddenRuntimeNames = [...new Set([
      ...(Array.isArray(web.forbiddenRuntimeValues) ? web.forbiddenRuntimeValues : []),
      ...(Array.isArray(runtimeContract.globallyForbiddenRuntimeValues) ? runtimeContract.globallyForbiddenRuntimeValues : []),
    ])].sort();
    const requiredPlatformNames = Array.isArray(web.requiredPlatformValues) ? [...web.requiredPlatformValues].sort() : [];
    section.projectId = project.projectId;
    section.teamId = project.teamId;
    section.staticContract = { requiredRuntimeNames, optionalRuntimeNames, forbiddenRuntimeNames, requiredPlatformNames };
    if (!inventory) {
      addFinding(findings, "vercel_runtime_inventory_unverified", "vercel", "A names-only Vercel production environment inventory is required.");
      return section;
    }
    const runtimeSet = new Set(inventory.runtimeNames);
    const missingRuntimeNames = requiredRuntimeNames.filter((name) => !runtimeSet.has(name));
    const forbiddenPresent = forbiddenRuntimeNames.filter((name) => runtimeSet.has(name));
    if (inventory.projectId !== project.projectId || inventory.teamId !== project.teamId) {
      addFinding(findings, "vercel_project_mismatch", "vercel", "The names-only inventory belongs to a different Vercel project or team.");
    }
    if (missingRuntimeNames.length > 0) {
      addFinding(findings, "vercel_runtime_names_missing", "vercel", `Missing required Vercel runtime names: ${missingRuntimeNames.join(", ")}.`);
    }
    if (forbiddenPresent.length > 0) {
      addFinding(findings, "vercel_forbidden_names_present", "vercel", `Forbidden Vercel names are present: ${forbiddenPresent.join(", ")}.`);
    }
    section.runtimeInventory = {
      ...inventory,
      missingRuntimeNames,
      forbiddenNamesPresent: forbiddenPresent,
    };
  } catch (error) {
    if (error instanceof SafeAuditError) throw error;
    addFinding(findings, "vercel_static_contract_unavailable", "vercel", "Vercel static project or runtime metadata is unavailable.");
  }
  section.status = findings.some(({ scope }) => scope === "vercel" || scope.startsWith("vercel.")) ? "fail" : "pass";
  return section;
}

export async function auditProductionEnvironment({
  rootDirectory = ROOT_DIRECTORY,
  repository,
  source = process.env,
  projectRef,
  vercelInventory = null,
  githubClient = createGithubClient(),
  flyClient = createFlyClient(),
  supabaseClient = null,
  supabaseClientFactory = createSupabaseClient,
  now = new Date(),
} = {}) {
  const findings = [];
  const requirements = await loadProductionRequirements(rootDirectory);
  const selectedProjectRef = projectRef?.trim() || source.ALBERT_CONTROL_PLANE_PROJECT_REF?.trim() || null;
  const selectedSupabaseClient = supabaseClient
    ?? supabaseClientFactory(safeCommandRunner, fetch, source);
  const [github, fly, supabase, vercel] = await Promise.all([
    auditGithub({
      client: githubClient,
      repository,
      requirements,
      findings,
      expectedCreatorAppId: source.ALBERT_RELEASE_AUTHORITY_CREATOR_APP_ID,
      expectedVendorIssuerAppId: source.ALBERT_VENDOR_ATTESTOR_TAG_ISSUER_APP_ID,
    }),
    auditFly({ client: flyClient, source, findings }),
    auditSupabase({
      client: selectedSupabaseClient,
      projectRef: selectedProjectRef,
      publicOrigin: source.ALBERT_PUBLIC_ORIGIN,
      findings,
    }),
    auditVercel({ rootDirectory, inventory: vercelInventory, findings }),
  ]);
  findings.sort((left, right) => `${left.scope}:${left.code}`.localeCompare(`${right.scope}:${right.code}`));
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    audit: "albert-production-environment",
    ok: findings.length === 0,
    sections: Object.freeze({ github, fly, supabase, vercel }),
    findings: Object.freeze(findings),
  });
}

export async function auditGithubReleaseAuthority({
  rootDirectory = ROOT_DIRECTORY,
  repository,
  source = process.env,
  githubClient = createGithubClient(),
  now = new Date(),
} = {}) {
  const findings = [];
  const requirements = await loadProductionRequirements(rootDirectory);
  const github = await auditGithub({
    client: githubClient,
    repository,
    requirements,
    findings,
    expectedCreatorAppId: source.ALBERT_RELEASE_AUTHORITY_CREATOR_APP_ID,
    expectedVendorIssuerAppId: source.ALBERT_VENDOR_ATTESTOR_TAG_ISSUER_APP_ID,
  });
  findings.sort((left, right) => `${left.scope}:${left.code}`.localeCompare(`${right.scope}:${right.code}`));
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    audit: "albert-github-release-authority",
    ok: findings.length === 0,
    sections: Object.freeze({ github }),
    findings: Object.freeze(findings),
  });
}

export function formatHumanSummary(result) {
  if (result.audit === "albert-github-release-authority") {
    const lines = [
      `Albert GitHub release authority audit: ${result.ok ? "PASS" : "FAIL"}`,
      `GitHub: ${result.sections.github.status}; ${result.sections.github.environments.filter(({ exists }) => exists).length}/${RELEASE_ENVIRONMENTS.length} environments available`,
    ];
    if (result.findings.length > 0) {
      lines.push("Findings:");
      for (const finding of result.findings) lines.push(`- [${finding.code}] ${finding.scope}: ${finding.message}`);
    }
    return `${lines.join("\n")}\n`;
  }
  const lines = [
    `Albert production environment audit: ${result.ok ? "PASS" : "FAIL"}`,
    `GitHub: ${result.sections.github.status}; ${result.sections.github.environments.filter(({ exists }) => exists).length}/${RELEASE_ENVIRONMENTS.length} environments available`,
    `Fly: ${result.sections.fly.status}; ${result.sections.fly.apps.filter(({ accessible }) => accessible).length}/${FLY_APP_VARIABLES.length} apps accessible`,
    `Supabase: ${result.sections.supabase.status}; region=${result.sections.supabase.region ?? "unverified"}; status=${result.sections.supabase.projectStatus ?? "unverified"}; auth=${result.sections.supabase.authPolicy?.status ?? "unverified"}`,
    `Vercel: ${result.sections.vercel.status}; project=${result.sections.vercel.projectId ?? "unverified"}`,
  ];
  if (result.findings.length > 0) {
    lines.push("Findings:");
    for (const finding of result.findings) lines.push(`- [${finding.code}] ${finding.scope}: ${finding.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "Usage: npm run audit:production-environment -- [options]",
    "",
    "Options:",
    "  --repo <owner/repository>              GitHub repository (defaults to gh repo view)",
    "  --supabase-project-ref <20-char-ref>   Selected control-plane project metadata",
    "  --vercel-inventory-names <path>        Names-only Vercel production inventory proof",
    "  --github-authority-only                Audit only live GitHub release authority controls",
    "  --help                                 Show this help",
    "",
    "JSON is written to stdout; the human summary is written to stderr.",
  ].join("\n");
}

function parseArguments(args) {
  const options = {
    repository: null,
    projectRef: null,
    vercelInventoryPath: null,
    githubAuthorityOnly: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--repo") options.repository = args[++index] ?? null;
    else if (argument === "--supabase-project-ref") options.projectRef = args[++index] ?? null;
    else if (argument === "--vercel-inventory-names") options.vercelInventoryPath = args[++index] ?? null;
    else if (argument === "--github-authority-only") options.githubAuthorityOnly = true;
    else throw safeFailure("invalid_argument", "Production audit received an unsupported argument.");
  }
  return options;
}

async function localLinkedProjectRef(rootDirectory) {
  try {
    return (await readFile(path.join(rootDirectory, "supabase/.temp/project-ref"), "utf8")).trim();
  } catch {
    return null;
  }
}

async function main() {
  let result;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (options.githubAuthorityOnly) {
      result = await auditGithubReleaseAuthority({
        repository: options.repository ?? process.env.GITHUB_REPOSITORY?.trim(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stderr.write(formatHumanSummary(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    let vercelInventory = null;
    const inventoryPath = options.vercelInventoryPath ?? process.env.ALBERT_VERCEL_ENVIRONMENT_NAMES_FILE?.trim();
    if (inventoryPath) vercelInventory = parseVercelInventoryNames(await readFile(path.resolve(inventoryPath), "utf8"));
    const projectRef = options.projectRef
      ?? process.env.ALBERT_CONTROL_PLANE_PROJECT_REF?.trim()
      ?? await localLinkedProjectRef(ROOT_DIRECTORY);
    result = await auditProductionEnvironment({
      repository: options.repository ?? process.env.GITHUB_REPOSITORY?.trim(),
      projectRef,
      vercelInventory,
    });
  } catch (error) {
    const code = error instanceof SafeAuditError ? error.code : "audit_failed";
    const message = error instanceof SafeAuditError ? error.message : "Production environment audit failed safely.";
    result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      audit: "albert-production-environment",
      ok: false,
      sections: {
        github: { status: "fail", environments: [] },
        fly: { status: "fail", apps: [] },
        supabase: { status: "fail", region: null, projectStatus: null, authPolicy: null },
        vercel: { status: "fail", projectId: null, teamId: null },
      },
      findings: [{ code, scope: "audit", message }],
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(formatHumanSummary(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
