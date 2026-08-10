import { defineConfig, devices } from "@playwright/test";

const appOrigin = "https://127.0.0.1:3101";
const internalAppOrigin = "http://127.0.0.1:3100";
const authOrigin = "http://127.0.0.1:55431";
const supabaseProjectRef = "abcdefghijklmnopqrst";

const appEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL: `https://${supabaseProjectRef}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "browser-acceptance-publishable-key",
  ALBERT_OAUTH_STATE_SECRET: "browser-acceptance-oauth-state-secret-00000001",
  ALBERT_OAUTH_WORKER_SIGNING_SECRET:
    "browser-acceptance-worker-signing-secret-01",
  ALBERT_SEMANTIC_SIGNING_SECRET: "browser-acceptance-semantic-secret-000001",
  ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET:
    "browser-acceptance-semantic-profile-secret-0001",
  ALBERT_ANTHROPIC_SIGNING_SECRET: "browser-acceptance-anthropic-secret-0001",
  ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET:
    "browser-acceptance-diagnostic-secret-001",
  ALBERT_USER_HASH_SECRET: "browser-acceptance-user-hash-secret-00001",
  ALBERT_PUBLIC_ORIGIN: appOrigin,
  SYNC_WORKER_INTERNAL_URL: "https://sync.browser-acceptance.invalid",
  SEMANTIC_QUERY_SERVICE_URL: "https://semantic.browser-acceptance.invalid",
  ANTHROPIC_ANALYTICS_SERVICE_URL:
    "https://anthropic.browser-acceptance.invalid",
  OPERATOR_DIAGNOSTIC_SERVICE_URL:
    "https://diagnostic.browser-acceptance.invalid",
  OPENAI_API_KEY: "browser-acceptance-openai-key",
  OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  LIGHTSPEED_CLIENT_ID: "browser-acceptance-lightspeed-client",
  XERO_CLIENT_ID: "browser-acceptance-xero-client",
  DEPUTY_CLIENT_ID: "browser-acceptance-deputy-client",
  ALBERT_CONTROL_PLANE_PROJECT_REF: supabaseProjectRef,
  ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
  ALBERT_MODEL_DATA_RESIDENCY_REGION: "au",
  ALBERT_MODEL_DATA_CONTROL_APPROVED: "true",
  ALBERT_LIGHTSPEED_PRODUCT: "r-series",
  ALBERT_CONVERSATION_RUNTIME: "live",
  ALBERT_ANALYTICAL_RUNTIME: "v1",
  ALBERT_ALLOW_FIXTURE_RUNTIME: "false",
  ALBERT_SERVICE_VERSION: "0000000000000000000000000000000000000000",
  ALBERT_DEPLOYMENT_ID: "browser-acceptance",
};

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: ".playwright/test-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { outputFolder: ".playwright/report", open: "never" }],
      ]
    : "list",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: appOrigin,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "auth-setup",
      testMatch: /auth\.setup\.ts/u,
    },
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts/u,
      dependencies: ["auth-setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".playwright/auth/user.json",
      },
    },
  ],
  webServer: [
    {
      command: "node tests/browser/support/supabase-auth-stub.mjs",
      url: `${authOrigin}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command:
        "npm run build && NODE_OPTIONS=--import=./tests/browser/support/server-fetch-rewrite.mjs npm run start -- -p 3100 -H 127.0.0.1",
      env: appEnvironment,
      url: `${internalAppOrigin}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: "node tests/browser/support/https-app-proxy.mjs",
      url: "http://127.0.0.1:3102/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
