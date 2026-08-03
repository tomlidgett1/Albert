import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const FLY_APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const FLY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SITES_ID = /^appg(?:prj|ver|dep)_[A-Za-z0-9_-]+(?:~appg(?:ver|dep)_[A-Za-z0-9_-]+)?$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_SITES_ATTESTATION_MS = 2 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const FLY_RUNTIME_CONTRACTS = Object.freeze([
  Object.freeze({ service: "deletion-worker", exposure: "private", readinessPath: "/readyz" }),
  Object.freeze({ service: "operator-diagnostic", exposure: "public", readinessPath: "/readyz" }),
  Object.freeze({ service: "semantic-query", exposure: "public", readinessPath: "/readyz" }),
  Object.freeze({ service: "sync-worker", exposure: "public", readinessPath: "/readyz" }),
  Object.freeze({ service: "transform-worker", exposure: "private", readinessPath: "/readyz" }),
  Object.freeze({ service: "webhook-gateway", exposure: "public", readinessPath: "/readyz" }),
]);

const runtimeByName = new Map(FLY_RUNTIME_CONTRACTS.map((runtime) => [runtime.service, runtime]));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function platformSha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value))
    .digest("hex");
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} shape is invalid.`);
}

function nonEmptyString(value, label, maximum = 512) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= maximum, `${label} is invalid.`);
  return value;
}

function distinct(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be distinct.`);
}

function canonicalHttpsOrigin(value, label) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${label} must use HTTPS.`);
  assert.equal(url.username, "", `${label} must not contain credentials.`);
  assert.equal(url.password, "", `${label} must not contain credentials.`);
  assert.equal(url.pathname, "/", `${label} must not contain a path.`);
  assert.equal(url.search, "", `${label} must not contain a query.`);
  assert.equal(url.hash, "", `${label} must not contain a fragment.`);
  assert.equal(value, url.origin, `${label} must be a canonical origin.`);
  return value;
}

function normalizeDigest(value, label) {
  assert.ok(typeof value === "string", `${label} is missing.`);
  const match = value.match(/sha256:[a-f0-9]{64}/u);
  assert.ok(match, `${label} is not an immutable sha256 digest.`);
  assert.match(match[0], OCI_DIGEST, `${label} is invalid.`);
  return match[0];
}

function validateFlyMachine(machine, runtime, options) {
  exactKeys(machine, [
    "id", "instanceId", "state", "region", "imageDigest", "configUpdatedAt", "configDigest",
    "releaseSha", "deploymentId", "runtimeIdentity", "readinessConfig",
  ], `Fly ${runtime.service} machine`);
  assert.match(machine.id, /^[a-f0-9]{14}$/u, `Fly ${runtime.service} machine id is invalid.`);
  assert.match(machine.instanceId, FLY_ID, `Fly ${runtime.service} instance id is invalid.`);
  assert.equal(machine.state, "started", `Fly ${runtime.service} contains a non-started machine.`);
  assert.equal(machine.region, "syd", `Fly ${runtime.service} machine is outside Sydney.`);
  assert.equal(machine.releaseSha, options.candidateSha, `Fly ${runtime.service} machine has the wrong candidate SHA.`);
  assert.equal(machine.deploymentId, options.deploymentId, `Fly ${runtime.service} machine has the wrong deployment id.`);
  assert.equal(machine.runtimeIdentity, runtime.service, `Fly ${runtime.service} machine has the wrong process identity.`);
  assert.equal(normalizeDigest(machine.imageDigest, `Fly ${runtime.service} image`), options.expectedImageDigest,
    `Fly ${runtime.service} machine has the wrong image digest.`);
  assert.ok(Number.isFinite(Date.parse(machine.configUpdatedAt)),
    `Fly ${runtime.service} platform config timestamp is invalid.`);
  assert.match(machine.configDigest, SHA256, `Fly ${runtime.service} platform config digest is invalid.`);
  exactKeys(machine.readinessConfig, ["type", "path", "port"], `Fly ${runtime.service} readiness config`);
  assert.equal(machine.readinessConfig.type, "http", `Fly ${runtime.service} readiness check must be HTTP.`);
  assert.equal(machine.readinessConfig.path, runtime.readinessPath,
    `Fly ${runtime.service} readiness path drifted.`);
  assert.ok(Number.isSafeInteger(machine.readinessConfig.port) && machine.readinessConfig.port > 0 &&
    machine.readinessConfig.port <= 65_535, `Fly ${runtime.service} readiness port is invalid.`);
}

function validateFlyCheck(check, runtime, machineIds) {
  exactKeys(check, ["machineId", "name", "status"], `Fly ${runtime.service} platform check`);
  assert.ok(machineIds.has(check.machineId), `Fly ${runtime.service} check references another Machine.`);
  assert.equal(check.name, "readiness", `Fly ${runtime.service} returned an unexpected check.`);
  assert.equal(check.status, "passing", `Fly ${runtime.service} readiness is not passing.`);
}

function validateFlySecret(secret, runtime) {
  exactKeys(secret, ["name", "digest"], `Fly ${runtime.service} secret binding`);
  assert.match(secret.name, /^[A-Z][A-Z0-9_]*$/u, `Fly ${runtime.service} secret name is invalid.`);
  assert.match(secret.digest, SHA256, `Fly ${runtime.service} secret digest is invalid.`);
}

/**
 * Validate a canonical observation assembled exclusively from Fly's read-only
 * control plane. HTTPS health response fields are deliberately absent.
 */
export function validateFlyPlatformProvenance(input, options) {
  assert.match(options?.candidateSha ?? "", COMMIT_SHA, "Fly candidate SHA is invalid.");
  exactKeys(input, ["schemaVersion", "kind", "organization", "apps", "observedAt"], "Fly platform observation");
  assert.equal(input.schemaVersion, 1, "Fly platform observation schema is invalid.");
  assert.equal(input.kind, "albert.fly-platform-provenance", "Fly platform observation kind is invalid.");
  assert.ok(Number.isFinite(Date.parse(input.observedAt)), "Fly observation time is invalid.");
  exactKeys(input.organization, ["id", "slug", "name"], "Fly organization");
  assert.match(input.organization.id, FLY_ID, "Fly organization id is invalid.");
  assert.match(input.organization.slug, FLY_APP_NAME, "Fly organization slug is invalid.");
  nonEmptyString(input.organization.name, "Fly organization name", 200);
  assert.ok(Array.isArray(input.apps), "Fly app evidence must be an array.");
  assert.equal(input.apps.length, FLY_RUNTIME_CONTRACTS.length, "Fly evidence must contain exactly six runtimes.");

  const observedDeploymentIds = input.apps.flatMap(({ machines }) => (
    Array.isArray(machines) ? machines.map(({ deploymentId }) => deploymentId) : []
  ));
  distinct(observedDeploymentIds.length > 0 ? [...new Set(observedDeploymentIds)] : [],
    "Fly observed deployment ids");
  assert.equal(new Set(observedDeploymentIds).size, 1,
    "Fly platform evidence must contain one exact deployment id.");
  const deploymentId = options?.deploymentId ?? observedDeploymentIds[0];
  assert.match(deploymentId ?? "", DEPLOYMENT_ID, "Fly deployment id is invalid.");
  const observedImageDigests = input.apps.flatMap(({ machines }) => (
    Array.isArray(machines) ? machines.map(({ imageDigest }) => normalizeDigest(imageDigest, "Observed Fly image")) : []
  ));
  assert.equal(new Set(observedImageDigests).size, 1,
    "Fly platform evidence must contain one exact immutable image digest.");
  const expectedImageDigest = options?.expectedImageDigest
    ? normalizeDigest(options.expectedImageDigest, "Expected Fly image")
    : observedImageDigests[0];

  const orderedApps = [...input.apps].sort((left, right) => left.service.localeCompare(right.service));
  assert.deepEqual(orderedApps.map(({ service }) => service), FLY_RUNTIME_CONTRACTS.map(({ service }) => service),
    "Fly evidence does not contain the exact runtime set.");
  distinct(orderedApps.map(({ app }) => app.id), "Fly application ids");
  distinct(orderedApps.map(({ app }) => app.name), "Fly application names");

  const apps = orderedApps.map((entry) => {
    exactKeys(entry, ["service", "exposure", "app", "machines", "checks", "ips", "secrets"],
      `Fly ${entry.service} evidence`);
    const runtime = runtimeByName.get(entry.service);
    assert.ok(runtime, `Fly returned unknown runtime ${entry.service}.`);
    assert.equal(entry.exposure, runtime.exposure, `Fly ${entry.service} exposure differs from the contract.`);
    exactKeys(entry.app, [
      "id", "name", "status", "hostname", "organizationId", "organizationSlug", "platformVersion",
      "publicServiceCount",
    ], `Fly ${entry.service} app`);
    assert.match(entry.app.id, FLY_ID, `Fly ${entry.service} app id is invalid.`);
    assert.match(entry.app.name, FLY_APP_NAME, `Fly ${entry.service} app name is invalid.`);
    assert.equal(entry.app.status, "running", `Fly ${entry.service} app is not running.`);
    assert.equal(entry.app.organizationId, input.organization.id, `Fly ${entry.service} belongs to another organization.`);
    assert.equal(entry.app.organizationSlug, input.organization.slug, `Fly ${entry.service} organization slug differs.`);
    nonEmptyString(entry.app.platformVersion, `Fly ${entry.service} platform version`, 128);
    assert.ok(Number.isSafeInteger(entry.app.publicServiceCount) && entry.app.publicServiceCount >= 0,
      `Fly ${entry.service} public-service count is invalid.`);

    assert.ok(Array.isArray(entry.machines) && entry.machines.length >= 2,
      `Fly ${entry.service} has insufficient protected Sydney capacity.`);
    for (const machine of entry.machines) {
      validateFlyMachine(machine, runtime, { ...options, deploymentId, expectedImageDigest });
    }
    distinct(entry.machines.map(({ id }) => id), `Fly ${entry.service} machine ids`);
    distinct(entry.machines.map(({ instanceId }) => instanceId), `Fly ${entry.service} instance ids`);
    const machineIds = new Set(entry.machines.map(({ id }) => id));

    assert.ok(Array.isArray(entry.checks), `Fly ${entry.service} platform checks are invalid.`);
    entry.checks.forEach((check) => validateFlyCheck(check, runtime, machineIds));
    for (const machineId of machineIds) {
      assert.equal(entry.checks.filter((check) => check.machineId === machineId && check.name === "readiness").length, 1,
        `Fly ${entry.service} Machine ${machineId} lacks one exact passing readiness check.`);
    }

    assert.ok(Array.isArray(entry.ips), `Fly ${entry.service} IP evidence is invalid.`);
    if (runtime.exposure === "private") {
      assert.equal(entry.app.publicServiceCount, 0,
        `Private Fly runtime ${entry.service} has a Fly Proxy service.`);
      assert.equal(entry.ips.length, 0, `Private Fly runtime ${entry.service} has a public IP.`);
    } else {
      assert.ok(entry.app.publicServiceCount > 0, `Public Fly runtime ${entry.service} has no Fly Proxy service.`);
      assert.match(entry.app.hostname ?? "", /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u,
        `Public Fly runtime ${entry.service} hostname is invalid.`);
      assert.ok(entry.ips.length > 0, `Public Fly runtime ${entry.service} has no allocated public IP.`);
      for (const ip of entry.ips) {
        exactKeys(ip, ["address", "type"], `Fly ${entry.service} IP`);
        nonEmptyString(ip.address, `Fly ${entry.service} IP address`, 128);
        assert.ok(ip.type === "v4" || ip.type === "v6" || ip.type === "shared_v4",
          `Fly ${entry.service} IP type is invalid.`);
      }
    }

    assert.ok(Array.isArray(entry.secrets), `Fly ${entry.service} secret evidence is invalid.`);
    entry.secrets.forEach((secret) => validateFlySecret(secret, runtime));
    distinct(entry.secrets.map(({ name }) => name), `Fly ${entry.service} secret names`);
    return Object.freeze({
      service: entry.service,
      exposure: runtime.exposure,
      appId: entry.app.id,
      appName: entry.app.name,
      origin: runtime.exposure === "public" ? `https://${entry.app.hostname}` : null,
      platformVersion: entry.app.platformVersion,
      machineIds: Object.freeze(entry.machines.map(({ id }) => id).sort()),
      machineConfigDigest: platformSha256(entry.machines.map((machine) => ({
        id: machine.id,
        instanceId: machine.instanceId,
        configUpdatedAt: machine.configUpdatedAt,
        configDigest: machine.configDigest,
        imageDigest: expectedImageDigest,
      })).sort((left, right) => left.id.localeCompare(right.id))),
      secretSetDigest: platformSha256(entry.secrets
        .map(({ name, digest }) => ({ name, digest }))
        .sort((left, right) => left.name.localeCompare(right.name))),
    });
  });
  const origins = apps.filter(({ origin }) => origin !== null).map(({ origin }) => origin);
  origins.forEach((origin) => canonicalHttpsOrigin(origin, "Fly-derived origin"));
  distinct(origins, "Fly public origins");
  const manifest = Object.freeze({
    organization: Object.freeze({ ...input.organization }),
    candidateSha: options.candidateSha,
    deploymentId,
    imageDigest: expectedImageDigest,
    observedAt: input.observedAt,
    apps: Object.freeze(apps),
  });
  return Object.freeze({ ...manifest, manifestDigest: platformSha256(manifest) });
}

function decodeDer(value, kind) {
  assert.match(value ?? "", BASE64URL, `${kind} key must be base64url DER.`);
  const decoded = Buffer.from(value, "base64url");
  assert.ok(decoded.length >= 32 && decoded.length <= 256, `${kind} key DER length is invalid.`);
  assert.equal(decoded.toString("base64url"), value, `${kind} key encoding is not canonical.`);
  return decoded;
}

function provenanceKeyId(keyInput) {
  const key = keyInput.type === "public" ? keyInput : createPublicKey(keyInput);
  assert.equal(key.asymmetricKeyType, "ed25519", "Platform provenance key must be Ed25519.");
  return `ed25519:${platformSha256(key.export({ type: "spki", format: "der" }))}`;
}

function validateSitesBody(input) {
  exactKeys(input, [
    "schemaVersion", "kind", "project", "version", "deployment", "accessPolicy",
    "environment", "customDomains", "observedAt", "expiresAt",
  ], "Sites platform provenance");
  assert.equal(input.schemaVersion, 1, "Sites provenance schema is invalid.");
  assert.equal(input.kind, "albert.sites-platform-provenance", "Sites provenance kind is invalid.");
  exactKeys(input.project, ["id", "status"], "Sites project");
  assert.match(input.project.id, /^appgprj_[a-f0-9]{32}$/u, "Sites project id is invalid.");
  assert.equal(input.project.status, "active", "Sites project is not active.");
  exactKeys(input.version, ["id", "number", "sourceCommitSha", "archiveContentHash"], "Sites version");
  assert.match(input.version.id, SITES_ID, "Sites version id is invalid.");
  assert.ok(Number.isSafeInteger(input.version.number) && input.version.number > 0, "Sites version number is invalid.");
  assert.match(input.version.sourceCommitSha, COMMIT_SHA, "Sites source commit is invalid.");
  assert.match(input.version.archiveContentHash, OCI_DIGEST, "Sites archive content hash is invalid.");
  exactKeys(input.deployment, [
    "id", "providerDeploymentId", "status", "type", "versionId", "url", "environmentRevision",
  ], "Sites deployment");
  assert.match(input.deployment.id, SITES_ID, "Sites deployment id is invalid.");
  nonEmptyString(input.deployment.providerDeploymentId, "Sites provider deployment id", 512);
  assert.equal(input.deployment.status, "succeeded", "Sites deployment has not succeeded.");
  assert.equal(input.deployment.type, "publish", "Sites evidence is not a production deployment.");
  assert.equal(input.deployment.versionId, input.version.id, "Sites deployment points at another version.");
  canonicalHttpsOrigin(input.deployment.url, "Sites deployment URL");
  assert.ok(Number.isSafeInteger(input.deployment.environmentRevision) && input.deployment.environmentRevision > 0,
    "Sites deployment environment revision is invalid.");
  exactKeys(input.accessPolicy, [
    "mode", "revision", "allowedAccountUserIds", "allowedGroupIds", "externalVisitorCount", "policyDigest",
  ], "Sites access policy");
  assert.ok(["public", "admins_only", "workspace_all", "custom"].includes(input.accessPolicy.mode),
    "Sites access mode is invalid.");
  assert.ok(Number.isSafeInteger(input.accessPolicy.revision) && input.accessPolicy.revision > 0,
    "Sites access-policy revision is invalid.");
  assert.ok(Array.isArray(input.accessPolicy.allowedAccountUserIds), "Sites user allowlist is invalid.");
  assert.ok(Array.isArray(input.accessPolicy.allowedGroupIds), "Sites group allowlist is invalid.");
  input.accessPolicy.allowedAccountUserIds.forEach((id) => nonEmptyString(id, "Sites allowed user id", 256));
  input.accessPolicy.allowedGroupIds.forEach((id) => nonEmptyString(id, "Sites allowed group id", 256));
  distinct(input.accessPolicy.allowedAccountUserIds, "Sites allowed user ids");
  distinct(input.accessPolicy.allowedGroupIds, "Sites allowed group ids");
  assert.ok(Number.isSafeInteger(input.accessPolicy.externalVisitorCount) && input.accessPolicy.externalVisitorCount >= 0,
    "Sites external visitor count is invalid.");
  assert.match(input.accessPolicy.policyDigest, SHA256, "Sites access-policy digest is invalid.");
  assert.equal(input.accessPolicy.policyDigest, platformSha256({
    mode: input.accessPolicy.mode,
    revision: input.accessPolicy.revision,
    allowedAccountUserIds: [...input.accessPolicy.allowedAccountUserIds].sort(),
    allowedGroupIds: [...input.accessPolicy.allowedGroupIds].sort(),
    externalVisitorCount: input.accessPolicy.externalVisitorCount,
  }), "Sites access-policy digest is inconsistent.");
  exactKeys(input.environment, ["revision", "entries", "entryBindingDigest"], "Sites environment");
  assert.equal(input.environment.revision, input.deployment.environmentRevision,
    "Sites deployment and current environment revisions differ.");
  assert.ok(Array.isArray(input.environment.entries), "Sites environment binding is invalid.");
  for (const entry of input.environment.entries) {
    exactKeys(entry, ["key", "isSecret", "valueDigest"], "Sites environment entry");
    assert.match(entry.key, /^[A-Z][A-Z0-9_]*$/u, "Sites environment key is invalid.");
    assert.equal(typeof entry.isSecret, "boolean", "Sites environment secret marker is invalid.");
    assert.match(entry.valueDigest, SHA256, "Sites environment value digest is invalid.");
  }
  distinct(input.environment.entries.map(({ key }) => key), "Sites environment keys");
  assert.match(input.environment.entryBindingDigest, SHA256, "Sites environment binding digest is invalid.");
  assert.equal(input.environment.entryBindingDigest, platformSha256(input.environment.entries
    .map((entry) => ({ ...entry })).sort((left, right) => left.key.localeCompare(right.key))),
  "Sites environment binding digest is inconsistent.");
  assert.ok(Array.isArray(input.customDomains), "Sites custom-domain evidence is invalid.");
  for (const domain of input.customDomains) {
    exactKeys(domain, ["id", "hostname", "status", "sslStatus"], "Sites custom domain");
    nonEmptyString(domain.id, "Sites custom-domain id", 256);
    assert.match(domain.hostname, /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u,
      "Sites custom-domain hostname is invalid.");
    assert.equal(domain.status, "active", `Sites custom domain ${domain.hostname} is not active.`);
    assert.equal(domain.sslStatus, "active", `Sites custom domain ${domain.hostname} TLS is not active.`);
  }
  distinct(input.customDomains.map(({ hostname }) => hostname), "Sites custom-domain hostnames");
  const observedAt = Date.parse(input.observedAt);
  const expiresAt = Date.parse(input.expiresAt);
  assert.ok(Number.isFinite(observedAt) && Number.isFinite(expiresAt), "Sites provenance time is invalid.");
  assert.ok(expiresAt > observedAt && expiresAt - observedAt <= MAX_SITES_ATTESTATION_MS,
    "Sites provenance lifetime is invalid.");
  return input;
}

export function signSitesPlatformProvenance(bodyInput, encodedPrivateKey) {
  const body = validateSitesBody(structuredClone(bodyInput));
  const privateKey = createPrivateKey({ key: decodeDer(encodedPrivateKey, "Sites private"), format: "der", type: "pkcs8" });
  assert.equal(privateKey.asymmetricKeyType, "ed25519", "Sites provenance private key must be Ed25519.");
  const signature = signBytes(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  return Object.freeze({
    provenance: Object.freeze(body),
    signature: Object.freeze({ algorithm: "Ed25519", keyId: provenanceKeyId(privateKey), value: signature }),
  });
}

export function verifySitesPlatformProvenance(envelopeInput, options) {
  const envelope = typeof envelopeInput === "string" ? JSON.parse(envelopeInput) : envelopeInput;
  exactKeys(envelope, ["provenance", "signature"], "Sites provenance envelope");
  const body = validateSitesBody(envelope.provenance);
  exactKeys(envelope.signature, ["algorithm", "keyId", "value"], "Sites provenance signature");
  assert.equal(envelope.signature.algorithm, "Ed25519", "Sites provenance signature algorithm is invalid.");
  assert.match(envelope.signature.value, BASE64URL, "Sites provenance signature is invalid.");
  const publicKey = createPublicKey({ key: decodeDer(options?.encodedPublicKey, "Sites public"), format: "der", type: "spki" });
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "Sites provenance public key must be Ed25519.");
  assert.equal(envelope.signature.keyId, provenanceKeyId(publicKey), "Sites provenance signer is not trusted.");
  assert.equal(verifyBytes(null, Buffer.from(canonicalJson(body)), publicKey,
    Buffer.from(envelope.signature.value, "base64url")), true, "Sites provenance signature is invalid.");
  assert.equal(body.project.id, options.projectId, "Sites provenance is for another project.");
  assert.equal(body.version.sourceCommitSha, options.candidateSha, "Sites saved source is not the candidate commit.");
  if (options.deploymentId !== undefined) {
    assert.equal(body.deployment.id, options.deploymentId, "Sites provenance is for another deployment.");
  }
  if (options.deploymentUrl !== undefined) {
    assert.equal(body.deployment.url, options.deploymentUrl, "Sites provenance URL differs from the sealed deployment URL.");
  }
  if (options.customDomains !== undefined) {
    assert.deepEqual(body.customDomains.map(({ hostname }) => hostname).sort(), [...options.customDomains].sort(),
      "Sites custom domains differ from the sealed release plan.");
  }
  if (options.accessMode !== undefined) {
    assert.equal(body.accessPolicy.mode, options.accessMode, "Sites access mode differs from the sealed release plan.");
  }
  if (options.accessPolicyDigest !== undefined) {
    assert.equal(body.accessPolicy.policyDigest, options.accessPolicyDigest,
      "Sites access policy differs from the sealed release plan.");
  }
  if (options.environmentRevision !== undefined) {
    assert.equal(body.environment.revision, options.environmentRevision,
      "Sites environment revision differs from the sealed release plan.");
  }
  if (options.environmentBindingDigest !== undefined) {
    assert.equal(body.environment.entryBindingDigest, options.environmentBindingDigest,
      "Sites environment binding differs from the sealed release plan.");
  }
  const now = options.now ?? Date.now();
  assert.ok(Date.parse(body.observedAt) <= now + CLOCK_SKEW_MS, "Sites provenance is issued in the future.");
  assert.ok(Date.parse(body.expiresAt) > now, "Sites provenance has expired.");
  const manifest = Object.freeze({
    projectId: body.project.id,
    versionId: body.version.id,
    versionNumber: body.version.number,
    sourceCommitSha: body.version.sourceCommitSha,
    archiveContentHash: body.version.archiveContentHash,
    deploymentId: body.deployment.id,
    providerDeploymentId: body.deployment.providerDeploymentId,
    deploymentUrl: body.deployment.url,
    environmentRevision: body.environment.revision,
    environmentBindingDigest: body.environment.entryBindingDigest,
    accessMode: body.accessPolicy.mode,
    accessPolicyRevision: body.accessPolicy.revision,
    accessPolicyDigest: body.accessPolicy.policyDigest,
    customDomains: Object.freeze(body.customDomains.map(({ hostname }) => hostname).sort()),
    observedAt: body.observedAt,
  });
  return Object.freeze({ ...manifest, manifestDigest: platformSha256(manifest) });
}

export function sitesAccessPolicyDigest(policy) {
  return platformSha256({
    mode: policy.mode,
    revision: policy.revision,
    allowedAccountUserIds: [...policy.allowedAccountUserIds].sort(),
    allowedGroupIds: [...policy.allowedGroupIds].sort(),
    externalVisitorCount: policy.externalVisitorCount,
  });
}

export function sitesEnvironmentBinding(entries) {
  assert.ok(Array.isArray(entries), "Sites environment entries must be an array.");
  const normalized = entries.map((entry) => {
    assert.match(entry.key ?? "", /^[A-Z][A-Z0-9_]*$/u, "Sites environment key is invalid.");
    assert.equal(typeof entry.isSecret, "boolean", "Sites environment secret marker is invalid.");
    if (entry.isSecret) {
      assert.ok(entry.value === null || (typeof entry.value === "string" && entry.value.length > 0),
        `Sites secret ${entry.key} has an invalid redacted value.`);
    } else {
      assert.ok(typeof entry.value === "string" && entry.value.length > 0,
        `Sites environment ${entry.key} requires a value to create a non-reversible binding.`);
    }
    return Object.freeze({
      key: entry.key,
      isSecret: entry.isSecret,
      valueDigest: entry.isSecret && entry.value === null
        ? platformSha256(`albert-sites-secret-presence-v1\0${entry.key}`)
        : platformSha256(`albert-sites-env-v1\0${entry.key}\0${entry.value}`),
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
  distinct(normalized.map(({ key }) => key), "Sites environment keys");
  return Object.freeze({ entries: Object.freeze(normalized), entryBindingDigest: platformSha256(normalized) });
}
