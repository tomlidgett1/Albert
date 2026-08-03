import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function secretName(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  for (const key of ["Name", "name", "NAME"]) {
    if (typeof entry[key] === "string") return entry[key];
  }
  return undefined;
}

export function validateRuntimeSecretNames(contract, runtimeName, payload) {
  const runtime = contract?.runtimes?.[runtimeName];
  assert.ok(runtime, `Unknown deployment runtime ${runtimeName}.`);
  assert.equal(runtime.platform, "fly", `${runtimeName} is not a Fly runtime.`);
  assert.ok(Array.isArray(payload), "Fly secret inventory must be a JSON array.");

  const names = payload.map(secretName);
  assert.equal(
    names.every((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]*$/u.test(name)),
    true,
    "Fly returned an invalid secret inventory.",
  );
  assert.equal(new Set(names).size, names.length, `${runtimeName} has duplicate secret names.`);

  const required = new Set(runtime.requiredSecretNames ?? []);
  const optional = new Set(runtime.optionalSecretNames ?? []);
  const forbidden = new Set(contract.globallyForbiddenRuntimeValues ?? []);
  for (const name of runtime.forbiddenRuntimeValues ?? []) forbidden.add(name);

  const missing = [...required].filter((name) => !names.includes(name)).sort();
  const prohibited = names.filter((name) => forbidden.has(name)).sort();
  const unexpected = names.filter((name) => !required.has(name) && !optional.has(name)).sort();
  assert.deepEqual(missing, [], `${runtimeName} is missing required secret names: ${missing.join(", ")}`);
  assert.deepEqual(prohibited, [], `${runtimeName} contains prohibited secret names: ${prohibited.join(", ")}`);
  assert.deepEqual(unexpected, [], `${runtimeName} contains undeclared secret names: ${unexpected.join(", ")}`);
  return Object.freeze({ runtimeName, count: names.length });
}

async function main() {
  const runtimeName = process.argv[2];
  const inventoryPath = process.argv[3];
  if (!runtimeName || !inventoryPath || process.argv.length !== 4) {
    throw new Error("Usage: node scripts/validate-runtime-secrets.mjs <runtime> <fly-secrets.json>");
  }
  const [contract, payload] = await Promise.all([
    readFile(new URL("../deploy/runtime-contract.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(inventoryPath, "utf8").then(JSON.parse),
  ]);
  const result = validateRuntimeSecretNames(contract, runtimeName, payload);
  process.stdout.write(`validated ${result.count} declared secret names for ${runtimeName}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
