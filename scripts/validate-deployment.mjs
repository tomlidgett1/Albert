import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const services = Object.freeze({
  "deletion-worker.toml": Object.freeze({
    command: "services/deletion-worker.js",
    port: 8083,
    exposure: "private",
  }),
  "semantic-query.toml": Object.freeze({
    command: "services/semantic-query.js",
    port: 8788,
    exposure: "signed-public",
  }),
  "sync-worker.toml": Object.freeze({
    command: "services/sync-worker.js",
    port: 8080,
    exposure: "signed-public",
  }),
  "transform-worker.toml": Object.freeze({
    command: "services/transform-worker.js",
    port: 8080,
    exposure: "private",
  }),
  "webhook-gateway.toml": Object.freeze({
    command: "services/webhook-gateway.js",
    port: 8081,
    exposure: "vendor-public",
  }),
});

const secretNames = Object.freeze([
  "API_KEY",
  "CLIENT_SECRET",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
  "SIGNING_SECRET",
  "ACCESS_KEY",
  "SERVICE_ROLE",
]);

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function section(body, name) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start === -1) return "";
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\s*\[/.test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n");
}

function includesAssignment(body, name, value) {
  const escapedName = escapeRegularExpression(name);
  const escapedValue = escapeRegularExpression(String(value));
  return new RegExp(`^\\s*${escapedName}\\s*=\\s*"?${escapedValue}"?\\s*$`, "mu").test(body);
}

const directory = new URL("../deploy/fly/", import.meta.url);
const actualFiles = (await readdir(directory))
  .filter((name) => name.endsWith(".toml"))
  .sort();
assert.deepEqual(actualFiles, Object.keys(services).sort(), "Fly service manifest set drifted.");

for (const [file, expected] of Object.entries(services)) {
  const body = await readFile(new URL(file, directory), "utf8");
  assert.match(body, /^primary_region\s*=\s*"syd"$/mu, `${file} must remain in Sydney.`);
  assert.match(body, /^kill_signal\s*=\s*"SIGTERM"$/mu, `${file} must drain on SIGTERM.`);
  assert.match(body, /^\s*dockerfile\s*=\s*"Dockerfile\.services"$/mu, `${file} must use the hardened service image.`);
  assert.match(body, new RegExp(`^\\s*app\\s*=\\s*"node --enable-source-maps ${escapeRegularExpression(expected.command)}"$`, "mu"), `${file} has the wrong process command.`);
  assert.match(body, /^\s*policy\s*=\s*"always"$/mu, `${file} must restart continuously.`);
  assert.match(body, /^\s*cpu_kind\s*=\s*"shared"$/mu, `${file} must declare an explicit CPU class.`);
  assert.match(body, /^\s*memory\s*=\s*"(?:512mb|1gb)"$/mu, `${file} must declare bounded memory.`);

  const environment = section(body, "env");
  assert.ok(includesAssignment(environment, "NODE_ENV", "production"), `${file} must run in production mode.`);
  for (const secretName of secretNames) {
    assert.equal(environment.includes(secretName), false, `${file} must not commit ${secretName} in [env].`);
  }

  if (expected.exposure === "private") {
    assert.equal(body.includes("[http_service]"), false, `${file} must not create a public Fly service.`);
    assert.match(body, /^\s*\[checks\.readiness\]\s*$/mu, `${file} requires an internal readiness check.`);
    assert.ok(includesAssignment(body, "port", expected.port), `${file} readiness port drifted.`);
    assert.match(body, /^\s*type\s*=\s*"http"$/mu, `${file} readiness check must use HTTP.`);
  } else {
    assert.match(body, /^\[http_service\]\s*$/mu, `${file} requires an explicit public service.`);
    assert.ok(includesAssignment(body, "internal_port", expected.port), `${file} public port drifted.`);
    assert.match(body, /^\s*force_https\s*=\s*true$/mu, `${file} must force HTTPS.`);
    assert.match(body, /^\s*auto_stop_machines\s*=\s*"off"$/mu, `${file} must not cold-start.`);
    assert.match(body, /^\s*min_machines_running\s*=\s*[1-9][0-9]*$/mu, `${file} must keep capacity running.`);
    assert.match(body, /^\s*path\s*=\s*"\/readyz"$/mu, `${file} requires a readiness route.`);
  }
}

const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
assert.match(hosting.project_id, /^appgprj_[a-f0-9]{32}$/, "Sites project ID is invalid.");
assert.equal(hosting.d1, null, "Albert must not attach a second control-plane database through Sites D1.");
assert.equal(hosting.r2, null, "Albert raw payloads must remain in governed Supabase Storage, not Sites R2.");

process.stdout.write(`validated ${actualFiles.length} Fly manifests and Sites hosting boundary\n`);
