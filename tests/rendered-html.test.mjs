import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("public root enters the authenticated product instead of a demo surface", async () => {
  const response = await render();
  assert.ok([303, 307, 308].includes(response.status));
  assert.equal(new URL(response.headers.get("location"), "http://localhost").pathname, "/login");
});

test("dash ships governed traces, run controls, connections, themes, and reduced motion", async () => {
  const [page, insightsTrace, legacyTrace, controls, connections, css, adr] = await Promise.all([
    readFile(new URL("../app/dash/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dash/components/InsightsStyleTrace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dash/components/AnalyticalTrace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dash/components/ModelRunControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dash/components/ConnectionsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dash/dash.module.css", import.meta.url), "utf8"),
    readFile(new URL("../docs/adr/0001-openai-agent-runtime-and-auditable-traces.md", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<InsightsStyleTrace/);
  assert.match(page, /<ModelRunControls/);
  assert.match(page, /<ConnectionsWorkspace/);
  assert.match(page, /fetch\("\/api\/conversation"/);
  assert.match(insightsTrace, /StreamingTrace|ThinkingTrail|DetailedTrail/);
  assert.match(insightsTrace, /runningShimmer|genieProgressShimmer|insightsAgentShimmer|streamingLive/);
  assert.match(insightsTrace, /Verified[\s\S]*Qualified[\s\S]*Exploratory[\s\S]*Clarification[\s\S]*Unavailable/);
  assert.doesNotMatch(insightsTrace, /compiledSql|rawReasoning|chainOfThought/i);
  assert.match(legacyTrace, /Explain this number/i);
  assert.match(controls, /Fast uses OpenAI/);
  assert.match(connections, /ready_partial/);
  assert.match(connections, /ready_complete/);
  assert.match(connections, /reauth_required/);
  assert.match(css, /\.dash\[data-theme="dark"\]/);
  assert.match(css, /\.dash\[data-theme="green"\]/);
  assert.match(css, /\.dash\[data-theme="system"\]/);
  assert.match(css, /--dash-canvas:\s*#12201c/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(adr, /Status:\s*Accepted/);
  assert.match(adr, /@openai\/agents/);
  assert.match(adr, /must not expose hidden reasoning/i);
});
