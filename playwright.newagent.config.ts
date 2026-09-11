import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Match the Next.js build deployed to Vercel, including the auth proxy.
export default defineConfig({
  ...base,
  testMatch: /(?:auth\.setup\.ts|newagent\.e2e\.spec\.ts)$/u,
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) => index === 1 ? {
    ...server,
    command: "npx next build --webpack && NODE_OPTIONS=--import=./tests/browser/support/server-fetch-rewrite.mjs npx next start -p 3100 -H 127.0.0.1",
    timeout: 240_000,
  } : server),
});
