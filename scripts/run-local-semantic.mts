#!/usr/bin/env npx tsx
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
    const index = raw.indexOf("=");
    const key = raw.slice(0, index).trim();
    let value = raw.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const root = resolve(import.meta.dirname, "..");
const local = loadEnvFile(resolve(root, ".env.local"));
const productionLocal = loadEnvFile(resolve(root, ".env.production.local"));
const env: Record<string, string | undefined> = { ...process.env };

for (const [key, value] of Object.entries(productionLocal)) {
  if (!local[key] && env[key] === undefined) env[key] = value;
}
for (const [key, value] of Object.entries(local)) env[key] = value;

const semanticControl = local.ALBERT_SEMANTIC_CONTROL_DATABASE_URL?.trim();
const semanticRead = local.ALBERT_SEMANTIC_READ_DATABASE_URL?.trim();
if (!semanticControl || !semanticRead) {
  console.error(
    "ALBERT_SEMANTIC_CONTROL_DATABASE_URL and ALBERT_SEMANTIC_READ_DATABASE_URL must be set in .env.local.",
  );
  process.exit(1);
}

// Shared .env.local keeps sync/ingest URLs in CONTROL_PLANE_DATABASE_URL /
// ANALYTICAL_DATABASE_URL. Semantic must remap to its dedicated runtimes.
env.CONTROL_PLANE_DATABASE_URL = semanticControl;
env.ANALYTICAL_DATABASE_URL = semanticRead;
env.NODE_ENV = env.NODE_ENV || "development";
env.ALBERT_SEMANTIC_HOST = env.ALBERT_SEMANTIC_HOST || "127.0.0.1";
env.ALBERT_SEMANTIC_PORT = env.ALBERT_SEMANTIC_PORT || "8788";
env.ALBERT_PUBLIC_ORIGIN = env.ALBERT_PUBLIC_ORIGIN || "http://localhost:3000";

const child = spawn(
  process.execPath,
  ["--import", "tsx", resolve(root, "services/semantic-query/src/main.ts")],
  { cwd: root, env: env as NodeJS.ProcessEnv, stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
