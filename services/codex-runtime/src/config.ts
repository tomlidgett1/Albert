import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  ALBERT_CODEX_PINNED_CLI_VERSION,
} from "../../../packages/albert-codex/src/contracts.js";

export type CodexRuntimeConfig = Readonly<{
  port: number;
  signingSecret: string;
  cubeApiUrl: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  binaryPath?: string;
  maxConcurrentTurns: number;
  pinnedCliVersion: string;
  releaseSha: string;
  deploymentId: string;
}>;

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function serviceUrl(value: string, name: string): string {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error(`${name} must use HTTPS.`);
  return url.toString().replace(/\/+$/u, "");
}

export function loadCodexRuntimeConfig(source: NodeJS.ProcessEnv = process.env): CodexRuntimeConfig {
  const signingSecret = source.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim()
    || (source.NODE_ENV === "production" ? "" : ALBERT_CODEX_LOCAL_SIGNING_SECRET);
  if (!signingSecret) throw new Error("ALBERT_CODEX_RUNTIME_SIGNING_SECRET is required.");
  if (Buffer.byteLength(signingSecret, "utf8") < 32) {
    throw new Error("ALBERT_CODEX_RUNTIME_SIGNING_SECRET must contain at least 32 UTF-8 bytes.");
  }
  const port = Number(source.PORT ?? "8792");
  const maxConcurrentTurns = Number(source.ALBERT_CODEX_MAX_CONCURRENT_TURNS ?? "2");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid.");
  if (!Number.isInteger(maxConcurrentTurns) || maxConcurrentTurns < 1 || maxConcurrentTurns > 16) {
    throw new Error("ALBERT_CODEX_MAX_CONCURRENT_TURNS must be between 1 and 16.");
  }
  const releaseSha = source.ALBERT_SERVICE_VERSION?.trim() || "development";
  const deploymentId = source.ALBERT_DEPLOYMENT_ID?.trim() || "localhost";
  if (source.NODE_ENV === "production" && !/^[a-f0-9]{40}$/u.test(releaseSha)) {
    throw new Error("ALBERT_SERVICE_VERSION must be the deployed Git SHA.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(deploymentId)) {
    throw new Error("ALBERT_DEPLOYMENT_ID is invalid.");
  }
  return Object.freeze({
    port,
    signingSecret,
    cubeApiUrl: serviceUrl(required(source, "CUBE_API_URL"), "CUBE_API_URL"),
    openaiApiKey: required(source, "OPENAI_API_KEY"),
    openaiBaseUrl: serviceUrl(required(source, "OPENAI_BASE_URL"), "OPENAI_BASE_URL"),
    ...(source.ALBERT_CODEX_BINARY_PATH?.trim() ? { binaryPath: source.ALBERT_CODEX_BINARY_PATH.trim() } : {}),
    maxConcurrentTurns,
    pinnedCliVersion: ALBERT_CODEX_PINNED_CLI_VERSION,
    releaseSha,
    deploymentId,
  });
}
