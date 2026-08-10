import { constants, accessSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BedrockClient, GetFoundationModelCommand, GetInferenceProfileCommand } from "@aws-sdk/client-bedrock";
import { Pool } from "pg";
import {
  ANTHROPIC_FALLBACK_MODEL,
  ANTHROPIC_PRIMARY_MODEL,
  loadLightspeedCatalogue,
} from "../../../packages/anthropic-analytics/src/index.js";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import { createAnthropicAnalyticsHttpHandler } from "./http.js";
import { startAnthropicAnalyticsNodeServer } from "./node-server.js";
import { PostgresAnthropicSessionRepository } from "./persistence.js";
import { AnthropicAnalyticsMetrics } from "./metrics.js";

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Expected a positive integer environment value.");
  return parsed;
}

function configuredClaudeExecutable(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.ALBERT_ANTHROPIC_CLAUDE_EXECUTABLE?.trim();
  if (!configured) return undefined;
  const executable = resolve(configured);
  try {
    if (!statSync(executable).isFile()) throw new Error("not a file");
    accessSync(executable, constants.X_OK);
  } catch {
    throw new Error("ALBERT_ANTHROPIC_CLAUDE_EXECUTABLE must identify an executable Claude Agent SDK binary.");
  }
  return executable;
}

function assertAnthropicControlDatabase(environment: NodeJS.ProcessEnv): void {
  const raw = required(environment, "ANTHROPIC_CONTROL_PLANE_DATABASE_URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("The Anthropic control-plane database URL is invalid."); }
  let login = "";
  try { login = decodeURIComponent(url.username); } catch { throw new Error("The Anthropic control-plane database login is invalid."); }
  if (!/^albert_anthropic_control_runtime(?:\.[a-z0-9]{20})?$/u.test(login)) {
    throw new Error("The Anthropic service requires its dedicated NOINHERIT control-plane login.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("The Anthropic session store must use PostgreSQL.");
  if (environment.NODE_ENV === "production") {
    if (url.searchParams.get("sslmode")?.toLowerCase() !== "require"
      && url.searchParams.get("sslmode")?.toLowerCase() !== "verify-ca"
      && url.searchParams.get("sslmode")?.toLowerCase() !== "verify-full") {
      throw new Error("The production Anthropic session store requires TLS.");
    }
    const projectRef = required(environment, "ALBERT_CONTROL_PLANE_PROJECT_REF");
    if (!/^[a-z0-9]{20}$/u.test(projectRef) || !(url.hostname === `db.${projectRef}.supabase.co` || login.endsWith(`.${projectRef}`))) {
      throw new Error("The Anthropic session store must target the approved control-plane project.");
    }
  }
}

function assertAnthropicServiceEnvironment(environment: NodeJS.ProcessEnv): void {
  assertAnthropicControlDatabase(environment);
  const semanticUrl = new URL(required(environment, "SEMANTIC_QUERY_SERVICE_URL"));
  if (semanticUrl.username || semanticUrl.password || !["http:", "https:"].includes(semanticUrl.protocol)
    || (environment.NODE_ENV === "production" && semanticUrl.protocol !== "https:")) {
    throw new Error("The signed semantic service URL is invalid.");
  }
  if (environment.NODE_ENV !== "production") return;
  if (required(environment, "ALBERT_CONTROL_PLANE_REGION") !== "ap-southeast-2"
    || required(environment, "ALBERT_MODEL_DATA_RESIDENCY_REGION").toLowerCase() !== "au"
    || required(environment, "ALBERT_MODEL_DATA_CONTROL_APPROVED") !== "true"
    || required(environment, "ALBERT_ANTHROPIC_APP8_APPROVED") !== "true"
    || required(environment, "ALBERT_ANTHROPIC_ZDR_APPROVED") !== "true"
    || required(environment, "ALBERT_ANTHROPIC_LOAD_TEST_APPROVED") !== "true") {
    throw new Error("Anthropic production privacy and regional controls are not approved.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(required(environment, "ALBERT_DEPLOYMENT_ID"))) {
    throw new Error("The Anthropic deployment identity is invalid.");
  }
}

function providerConfiguration(environment: NodeJS.ProcessEnv): Readonly<{
  model: string;
  fallbackModel: string;
  providerEnvironment: Readonly<Record<string, string | undefined>>;
  ready: () => Promise<boolean>;
}> {
  const production = environment.NODE_ENV === "production";
  const provider = environment.ALBERT_ANTHROPIC_PROVIDER?.trim() || (production ? "bedrock" : "direct");
  if (production) {
    if (provider !== "bedrock") throw new Error("Production Anthropic analytics must use the approved Bedrock path.");
    if (environment.AWS_REGION !== "ap-southeast-2" || environment.ALBERT_MODEL_DATA_RESIDENCY_REGION?.toLowerCase() !== "au") {
      throw new Error("Production Anthropic analytics requires the approved ap-southeast-2 processing boundary.");
    }
    if (environment.ALBERT_MODEL_DATA_CONTROL_APPROVED !== "true") throw new Error("Anthropic production data controls are not approved.");
    const model = required(environment, "ALBERT_ANTHROPIC_BEDROCK_MODEL");
    const fallbackModel = required(environment, "ALBERT_ANTHROPIC_BEDROCK_FALLBACK_MODEL");
    required(environment, "AWS_ACCESS_KEY_ID");
    required(environment, "AWS_SECRET_ACCESS_KEY");
    const approvedProfile = (value: string, family: "opus" | "sonnet") => (
      value.startsWith("au.") && new RegExp(`anthropic\\.claude-${family}-5`, "iu").test(value)
    ) || (
      /^arn:aws:bedrock:ap-southeast-(?:2|4):[0-9]{12}:inference-profile\/au\./u.test(value)
      && new RegExp(`anthropic\\.claude-${family}-5`, "iu").test(value)
    );
    if (!approvedProfile(model, "opus") || !approvedProfile(fallbackModel, "sonnet")) {
      throw new Error("Bedrock model identifiers must be explicit AU inference profiles for Opus primary and Sonnet fallback.");
    }
    const bedrock = new BedrockClient({ region: environment.AWS_REGION });
    let preflight: Promise<boolean> | undefined;
    let preflightResult: Readonly<{ checkedAt: number; ready: boolean }> | undefined;
    const providerReady = () => {
      if (preflightResult && Date.now() - preflightResult.checkedAt < 60_000) return Promise.resolve(preflightResult.ready);
      preflight ??= Promise.all([
        { identifier: model, family: "opus" },
        { identifier: fallbackModel, family: "sonnet" },
      ].map(async ({ identifier, family }) => {
        const profile = await bedrock.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: identifier }));
        if (!profile.inferenceProfileArn || !profile.models?.length) return false;
        const expected = new RegExp(`anthropic\\.claude-${family}-5`, "iu");
        if (!profile.models.every(({ modelArn }) => (
          typeof modelArn === "string"
          && /^arn:aws:bedrock:ap-southeast-(?:2|4)::foundation-model\//u.test(modelArn)
          && expected.test(modelArn)
        ))) return false;
        const foundations = await Promise.all(profile.models.map(async ({ modelArn }) => {
          const response = await bedrock.send(new GetFoundationModelCommand({ modelIdentifier: modelArn! }));
          return response.modelDetails?.modelLifecycle?.status === "ACTIVE"
            && response.modelDetails?.responseStreamingSupported === true;
        }));
        return foundations.every(Boolean);
      })).then((checks) => checks.every(Boolean)).catch(() => false).then((ready) => {
        preflightResult = Object.freeze({ checkedAt: Date.now(), ready });
        return ready;
      }).finally(() => { preflight = undefined; });
      return preflight;
    };
    return {
      model,
      fallbackModel,
      providerEnvironment: Object.freeze({
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: environment.AWS_REGION,
        AWS_DEFAULT_REGION: environment.AWS_REGION,
        AWS_ACCESS_KEY_ID: environment.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: environment.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: environment.AWS_SESSION_TOKEN,
        AWS_PROFILE: environment.AWS_PROFILE,
        PATH: environment.PATH,
        LANG: environment.LANG,
        NODE_EXTRA_CA_CERTS: environment.NODE_EXTRA_CA_CERTS,
      }),
      ready: providerReady,
    };
  }
  if (provider !== "direct") throw new Error("Local Anthropic analytics supports the direct API provider only.");
  const apiKey = required(environment, "ANTHROPIC_API_KEY");
  return {
    model: ANTHROPIC_PRIMARY_MODEL,
    fallbackModel: ANTHROPIC_FALLBACK_MODEL,
    providerEnvironment: Object.freeze({
      ANTHROPIC_API_KEY: apiKey,
      PATH: environment.PATH,
      LANG: environment.LANG,
      NODE_EXTRA_CA_CERTS: environment.NODE_EXTRA_CA_CERTS,
    }),
    ready: async () => apiKey.startsWith("sk-ant-") && apiKey.length > 40,
  };
}

export async function startAnthropicAnalyticsService(environment: NodeJS.ProcessEnv = process.env) {
  assertAnthropicServiceEnvironment(environment);
  const releaseSha = assertEmbeddedServiceBuildIdentity(environment);
  const signingSecret = required(environment, "ALBERT_ANTHROPIC_SIGNING_SECRET");
  const semanticSigningSecret = required(environment, "ALBERT_SEMANTIC_SIGNING_SECRET");
  if (Buffer.byteLength(signingSecret, "utf8") < 32 || Buffer.byteLength(semanticSigningSecret, "utf8") < 32) {
    throw new Error("Anthropic and semantic signing secrets must each be at least 32 bytes.");
  }
  const provider = providerConfiguration(environment);
  const claudeCodeExecutable = configuredClaudeExecutable(environment);
  const pool = new Pool({
    connectionString: required(environment, "ANTHROPIC_CONTROL_PLANE_DATABASE_URL"),
    max: integer(environment.ALBERT_ANTHROPIC_CONTROL_POOL_SIZE, 8),
    application_name: "albert-anthropic-analytics",
  });
  const repository = new PostgresAnthropicSessionRepository(pool);
  const metrics = new AnthropicAnalyticsMetrics();
  const catalogue = await loadLightspeedCatalogue(resolve(environment.ALBERT_LIGHTSPEED_TABLE_CATALOGUE ?? "connectors/lightspeed-r/tables.json"));
  const handler = createAnthropicAnalyticsHttpHandler({
    signingSecret,
    repository,
    runConfiguration: {
      semanticServiceUrl: required(environment, "SEMANTIC_QUERY_SERVICE_URL"),
      semanticSigningSecret,
      providerEnvironment: provider.providerEnvironment,
      catalogue,
      model: provider.model,
      fallbackModel: provider.fallbackModel,
      pathToClaudeCodeExecutable: claudeCodeExecutable,
      maxTurns: 20,
      maxBudgetUsd: 3,
      timeoutMs: 180_000,
    },
    releaseSha,
    deploymentId: environment.ALBERT_DEPLOYMENT_ID?.trim() || null,
    providerReady: provider.ready,
    metrics,
  });
  return startAnthropicAnalyticsNodeServer({
    handler,
    host: environment.ALBERT_ANTHROPIC_HOST ?? "127.0.0.1",
    port: integer(environment.ALBERT_ANTHROPIC_PORT, 8791),
    closeRepository: () => repository.close(),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const running = await startAnthropicAnalyticsService();
  process.stdout.write(`anthropic analytics listening on ${running.url}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await running.close();
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
