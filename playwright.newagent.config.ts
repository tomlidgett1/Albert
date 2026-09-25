import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import base from "./playwright.config";

const blockingQuestions = JSON.parse(readFileSync(new URL("./contracts/blocking-questions.v1.json", import.meta.url), "utf8")) as { digest: string };

// Match the Next.js build deployed to Vercel, including the auth proxy.
export default defineConfig({
  ...base,
  testMatch: /(?:auth\.setup\.ts|newagent\.e2e\.spec\.ts)$/u,
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) => index === 1 ? {
    ...server,
    env: {
      ...server.env,
      ALBERT_BUILD_NO_CACHE: "true",
      ALBERT_PUBLIC_ORIGIN: "https://albert.browser-acceptance.invalid",
      ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST: blockingQuestions.digest,
    },
    command: `${process.env.ALBERT_NEWAGENT_SKIP_BUILD === "true" ? "" : "npx next build --webpack && "}NODE_OPTIONS=--import=./tests/browser/support/server-fetch-rewrite.mjs npx next start -p 3100 -H 127.0.0.1`,
    timeout: 240_000,
  } : server),
});
