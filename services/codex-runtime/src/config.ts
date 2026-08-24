import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  ALBERT_CODEX_PINNED_CLI_VERSION,
} from "../../../packages/albert-codex/src/contracts.js";
import type { CodexAppServerAuthentication } from "../../../packages/albert-codex/src/app-server.js";

export type CodexRuntimeConfig = Readonly<{
  port: number;
  listenHost: "0.0.0.0" | "127.0.0.1";
  signingSecret: string;
  cubeApiUrl: string;
  authentication: CodexAppServerAuthentication;
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
  const authenticationMode = source.ALBERT_CODEX_AUTH_MODE?.trim() || "api";
  if (authenticationMode !== "api" && authenticationMode !== "chatgpt") {
    throw new Error("ALBERT_CODEX_AUTH_MODE must be api or chatgpt.");
  }
  if (source.NODE_ENV === "production" && authenticationMode !== "api") {
    throw new Error("Production Codex runtime authentication must use the API deployer identity.");
  }
  const listenHost = source.ALBERT_CODEX_LISTEN_HOST?.trim()
    || (authenticationMode === "chatgpt" ? "127.0.0.1" : "0.0.0.0");
  if (listenHost !== "0.0.0.0" && listenHost !== "127.0.0.1") {
    throw new Error("ALBERT_CODEX_LISTEN_HOST must be 0.0.0.0 or 127.0.0.1.");
  }
  if (authenticationMode === "chatgpt" && listenHost !== "127.0.0.1") {
    throw new Error("ChatGPT subscription authentication must listen on loopback only.");
  }
  let authentication: CodexAppServerAuthentication;
  if (authenticationMode === "api") {
    authentication = Object.freeze({
      mode: "api",
      apiKey: required(source, "OPENAI_API_KEY"),
      baseUrl: serviceUrl(required(source, "OPENAI_BASE_URL"), "OPENAI_BASE_URL"),
    });
  } else {
    const codexHome = source.ALBERT_CODEX_CHATGPT_HOME?.trim()
      || source.CODEX_HOME?.trim()
      || join(homedir(), ".codex");
    if (!isAbsolute(codexHome)) {
      throw new Error("ALBERT_CODEX_CHATGPT_HOME must be an absolute path.");
    }
    authentication = Object.freeze({ mode: "chatgpt", codexHome });
  }
  return Object.freeze({
    port,
    listenHost,
    signingSecret,
    cubeApiUrl: serviceUrl(required(source, "CUBE_API_URL"), "CUBE_API_URL"),
    authentication,
    ...(source.ALBERT_CODEX_BINARY_PATH?.trim() ? { binaryPath: source.ALBERT_CODEX_BINARY_PATH.trim() } : {}),
    maxConcurrentTurns,
    pinnedCliVersion: ALBERT_CODEX_PINNED_CLI_VERSION,
    releaseSha,
    deploymentId,
  });
}
