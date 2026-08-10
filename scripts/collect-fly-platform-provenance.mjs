import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  FLY_RUNTIME_CONTRACTS,
  platformSha256,
  validateFlyPlatformProvenance,
} from "./platform-provenance.mjs";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const runtimeNames = new Set(FLY_RUNTIME_CONTRACTS.map(({ service }) => service));

function valueAt(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const name of names) {
    if (value[name] !== undefined) return value[name];
  }
  return undefined;
}

function asArray(value, keys, label) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  assert.fail(`${label} is not a JSON array.`);
}

function requiredString(value, label, maximum = 512) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= maximum, `${label} is invalid.`);
  return value;
}

function normalizedAppName(item) {
  const name = valueAt(item, ["name", "Name", "app_name", "AppName"]);
  assert.match(name ?? "", APP_NAME, "Fly returned an invalid application name.");
  return name;
}

function runtimeIdentity(machine) {
  const identity = machine?.config?.env?.ALBERT_RUNTIME_IDENTITY;
  return runtimeNames.has(identity) ? identity : null;
}

function candidateAppNames(rawApps, machinesByApp, candidateSha) {
  const matches = [];
  for (const app of asArray(rawApps, ["apps", "Apps"], "Fly application inventory")) {
    const name = normalizedAppName(app);
    const machines = asArray(machinesByApp[name], ["machines", "Machines"], `Fly ${name} Machine inventory`);
    const candidateMachines = machines.filter((machine) => (
      machine?.config?.env?.ALBERT_SERVICE_VERSION === candidateSha && runtimeIdentity(machine)
    ));
    if (candidateMachines.length === 0) continue;
    const identities = new Set(candidateMachines.map(runtimeIdentity));
    assert.equal(identities.size, 1, `Fly app ${name} mixes candidate runtime identities.`);
    matches.push({ name, service: [...identities][0] });
  }
  assert.equal(matches.length, FLY_RUNTIME_CONTRACTS.length,
    `Fly token must reveal exactly ${FLY_RUNTIME_CONTRACTS.length} candidate runtime applications.`);
  assert.deepEqual(matches.map(({ service }) => service).sort(), [...runtimeNames].sort(),
    "Fly token does not reveal the exact candidate runtime identities.");
  assert.equal(new Set(matches.map(({ name }) => name)).size, matches.length,
    "Fly candidate applications are not distinct.");
  return matches;
}

function organizationRecord(rawOrganizations, slug) {
  const organizations = asArray(rawOrganizations, ["organizations", "Organizations"], "Fly organization inventory");
  const matches = organizations.filter((item) => valueAt(item, ["slug", "Slug"]) === slug);
  assert.equal(matches.length, 1, `Fly returned no unique organization identity for ${slug}.`);
  const record = matches[0];
  return {
    id: requiredString(valueAt(record, ["id", "ID", "Id"]), "Fly organization id", 256),
    slug,
    name: requiredString(valueAt(record, ["name", "Name"]), "Fly organization name", 200),
  };
}

function readinessConfig(machine, service) {
  const check = machine?.config?.checks?.readiness;
  assert.ok(check && typeof check === "object" && !Array.isArray(check),
    `Fly ${service} Machine lacks the named platform readiness configuration.`);
  return {
    type: String(check.type ?? "").toLowerCase(),
    path: check.path,
    port: Number(check.port),
  };
}

function readinessStatus(machine, service) {
  const checks = machine?.checks;
  let raw;
  if (checks && typeof checks === "object" && !Array.isArray(checks)) raw = checks.readiness;
  if (Array.isArray(checks)) raw = checks.find((check) => valueAt(check, ["name", "Name"]) === "readiness");
  const status = typeof raw === "string" ? raw : valueAt(raw, ["status", "Status"]);
  assert.ok(typeof status === "string", `Fly ${service} Machine lacks a platform readiness result.`);
  return status.toLowerCase() === "passing" || status.toLowerCase() === "pass"
    ? "passing"
    : status.toLowerCase();
}

function normalizedIp(item) {
  const rawType = String(valueAt(item, ["type", "Type", "kind", "Kind"]) ?? "").toLowerCase();
  const type = rawType === "shared_v4" || rawType === "shared-v4"
    ? "shared_v4"
    : rawType.includes("6") ? "v6" : rawType.includes("4") ? "v4" : rawType;
  return {
    address: requiredString(valueAt(item, ["address", "Address"]), "Fly IP address", 128),
    type,
  };
}

function normalizedSecret(item) {
  const name = valueAt(item, ["name", "Name", "NAME"]);
  assert.match(name ?? "", /^[A-Z][A-Z0-9_]*$/u, "Fly returned an invalid secret name.");
  const platformDigest = requiredString(valueAt(item, ["digest", "Digest", "DIGEST"]),
    `Fly secret ${name} platform digest`, 512);
  return { name, digest: platformSha256(`albert-fly-secret-v1\0${name}\0${platformDigest}`) };
}

export function buildFlyPlatformObservation(raw, { candidateSha, observedAt }) {
  assert.match(candidateSha ?? "", COMMIT_SHA, "Fly candidate SHA is invalid.");
  assert.ok(Number.isFinite(Date.parse(observedAt)), "Fly observation time is invalid.");
  const candidates = candidateAppNames(raw.apps, raw.machinesByApp, candidateSha);
  const canonicalApps = candidates.map(({ name, service }) => {
    const detail = raw.appDetailsByName[name];
    assert.ok(detail && typeof detail === "object" && !Array.isArray(detail), `Fly app ${name} details are absent.`);
    assert.equal(valueAt(detail, ["name", "Name"]), name, `Fly app ${name} detail identity differs.`);
    const organization = valueAt(detail, ["organization", "Organization"]);
    const organizationSlug = requiredString(valueAt(organization, ["slug", "Slug"]),
      `Fly app ${name} organization slug`, 64);
    const machines = asArray(raw.machinesByApp[name], ["machines", "Machines"], `Fly ${name} Machine inventory`);
    assert.ok(machines.length > 0, `Fly app ${name} has no Machines.`);
    const serviceCounts = machines.map((machine) => Array.isArray(machine?.config?.services)
      ? machine.config.services.length
      : 0);
    assert.equal(new Set(serviceCounts).size, 1, `Fly app ${name} Machines disagree on Proxy services.`);
    return {
      service,
      exposure: FLY_RUNTIME_CONTRACTS.find((item) => item.service === service).exposure,
      organizationSlug,
      app: {
        id: requiredString(valueAt(detail, ["id", "ID", "Id"]), `Fly app ${name} id`, 256),
        name,
        status: machines.every(({ state }) => state === "started") ? "running" : "not-running",
        hostname: `${name}.fly.dev`,
        organizationId: null,
        organizationSlug,
        platformVersion: requiredString(String(valueAt(detail, ["status", "Status"])),
          `Fly app ${name} platform status`, 128),
        publicServiceCount: serviceCounts[0],
      },
      machines: machines.map((machine) => ({
        id: machine.id,
        instanceId: machine.instance_id,
        state: machine.state,
        region: machine.region,
        imageDigest: machine.image_ref?.digest ?? machine.config?.image,
        configUpdatedAt: machine.updated_at,
        configDigest: platformSha256(machine.config),
        releaseSha: machine.config?.env?.ALBERT_SERVICE_VERSION,
        deploymentId: machine.config?.env?.ALBERT_DEPLOYMENT_ID,
        runtimeIdentity: machine.config?.env?.ALBERT_RUNTIME_IDENTITY,
        readinessConfig: readinessConfig(machine, service),
      })),
      checks: machines.map((machine) => ({
        machineId: machine.id,
        name: "readiness",
        status: readinessStatus(machine, service),
      })),
      ips: asArray(raw.ipsByApp[name], ["ips", "IPs"], `Fly ${name} IP inventory`).map(normalizedIp),
      secrets: asArray(raw.secretsByApp[name], ["secrets", "Secrets"], `Fly ${name} secret inventory`)
        .map(normalizedSecret),
    };
  });
  const organizationSlugs = new Set(canonicalApps.map(({ organizationSlug }) => organizationSlug));
  assert.equal(organizationSlugs.size, 1, "Candidate Fly apps do not belong to one organization.");
  const organization = organizationRecord(raw.organizations, [...organizationSlugs][0]);
  for (const entry of canonicalApps) {
    entry.app.organizationId = organization.id;
    delete entry.organizationSlug;
  }
  return {
    schemaVersion: 1,
    kind: "albert.fly-platform-provenance",
    organization,
    apps: canonicalApps,
    observedAt,
  };
}

async function machinesApi(fetchImpl, token, path) {
  const response = await fetchImpl(new URL(path, "https://api.machines.dev"), {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, `Fly Machines API ${path} failed with HTTP ${response.status}.`);
  const body = await response.json().catch(() => null);
  assert.ok(body && typeof body === "object", `Fly Machines API ${path} returned invalid JSON.`);
  return body;
}

export async function collectFlyPlatformProvenance({
  candidateSha,
  token,
  flyctlJson,
  fetchImpl = fetch,
  now = new Date(),
}) {
  assert.match(candidateSha ?? "", COMMIT_SHA, "Fly candidate SHA is invalid.");
  assert.ok(typeof token === "string" && token.length >= 20, "Fly read-only token is missing or invalid.");
  assert.equal(typeof flyctlJson, "function", "Fly collector requires a protected flyctl JSON executor.");
  const [apps, organizations] = await Promise.all([
    flyctlJson(token, ["apps", "list", "--json"]),
    flyctlJson(token, ["orgs", "list", "--json"]),
  ]);
  const appInventory = asArray(apps, ["apps", "Apps"], "Fly application inventory");
  assert.ok(appInventory.length > 0 && appInventory.length <= 100,
    "Fly read-only identity exposes an invalid number of applications.");
  const names = appInventory.map(normalizedAppName);
  assert.equal(new Set(names).size, names.length, "Fly application inventory contains duplicate names.");
  const machinesByApp = Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    await machinesApi(fetchImpl, token, `/v1/apps/${encodeURIComponent(name)}/machines`),
  ])));
  const candidates = candidateAppNames(apps, machinesByApp, candidateSha);
  const appDetailsByName = Object.fromEntries(await Promise.all(candidates.map(async ({ name }) => [
    name,
    await machinesApi(fetchImpl, token, `/v1/apps/${encodeURIComponent(name)}`),
  ])));
  const [ipsEntries, secretEntries] = await Promise.all([
    Promise.all(candidates.map(async ({ name }) => [name,
      await flyctlJson(token, ["ips", "list", "--app", name, "--json"])])),
    Promise.all(candidates.map(async ({ name }) => [name,
      await flyctlJson(token, ["secrets", "list", "--app", name, "--json"])])),
  ]);
  const observation = buildFlyPlatformObservation({
    apps,
    organizations,
    machinesByApp,
    appDetailsByName,
    ipsByApp: Object.fromEntries(ipsEntries),
    secretsByApp: Object.fromEntries(secretEntries),
  }, { candidateSha, observedAt: now.toISOString() });
  return validateFlyPlatformProvenance(observation, { candidateSha });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.fail("collect-fly-platform-provenance.mjs is a library; use collect-dogfood-acceptance.mjs.");
}
