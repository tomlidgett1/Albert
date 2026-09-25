import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { distillProactiveAnswer } from "../../services/proactive/src/distill.ts";
import {
  PROACTIVE_AGENT_ROSTER,
  PROACTIVE_CLIENT_CONCURRENCY,
  PROACTIVE_MODEL,
  PROACTIVE_REASONING_EFFORT,
  rosterForConnectors,
} from "../../services/proactive/src/roster.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const page = read("app/dash/page.tsx");
const workspace = read("app/dash/components/ProactiveWorkspace.tsx");
const sideChat = read("app/dash/components/ProactiveSideChat.tsx");
const controller = read("app/dash/lib/proactive-run-controller.ts");
const panelRoute = read("app/api/proactive/route.ts");
const runRoute = read("app/api/proactive/run/route.ts");
const findingRoute = read("app/api/proactive/finding/route.ts");
const repository = read("services/control-plane/src/proactive-repository.ts");
const synthesisRoute = read("app/api/proactive/synthesis/route.ts");
const synthesisModule = read("services/proactive/src/synthesis.ts");
const migration = read("infra/migrations/control-plane/0158_m6_proactive_control_panel.sql");
const synthesisMigration = read("infra/migrations/control-plane/0159_m6_proactive_synthesis.sql");
const adr = read("docs/adr/0113-proactive-control-panel.md");

test("Proactive is a first-class dash view wired into the shell", () => {
  assert.match(page, /import ProactiveWorkspace from "\.\/components\/ProactiveWorkspace"/u);
  assert.match(page, /type ActiveItem =[^;]*"Proactive"/su);
  assert.match(page, /requestedView === "Proactive"[\s\S]*setActiveItem\("Proactive"\)/u);
  assert.match(page, /aria-label="Proactive"[\s\S]*aria-current=\{activeItem === "Proactive" \? "page"/u);
  assert.match(page, /activeItem === "Proactive"[\s\S]*<ProactiveWorkspace/u);
  // Research conversations stay out of sidebar history.
  assert.match(page, /proactiveConversationIds\.has\(conversation\.conversationId\)/u);
});

test("the roster is a bounded fleet of Terra-max research agents", () => {
  assert.equal(PROACTIVE_AGENT_ROSTER.length, 15);
  assert.equal(PROACTIVE_MODEL, "gpt-5.6-terra");
  assert.equal(PROACTIVE_REASONING_EFFORT, "max");
  assert.ok(PROACTIVE_CLIENT_CONCURRENCY >= 1 && PROACTIVE_CLIENT_CONCURRENCY <= 8);
  const keys = new Set(PROACTIVE_AGENT_ROSTER.map((agent) => agent.key));
  assert.equal(keys.size, PROACTIVE_AGENT_ROSTER.length);
  for (const agent of PROACTIVE_AGENT_ROSTER) {
    assert.match(agent.key, /^[a-z][a-z0-9-]{2,60}$/u);
    assert.ok(agent.title.length >= 1 && agent.title.length <= 120);
    assert.ok(agent.tagline.length <= 240);
    // Prompts travel as codex user messages: stay well under the 8k cap.
    assert.ok(agent.prompt.length >= 200 && agent.prompt.length <= 4000, agent.key);
    assert.match(agent.prompt, /control panel/u);
  }
  // Ashburton Cycles' connector set runs the full roster.
  assert.equal(rosterForConnectors(["lightspeed-r", "xero", "deputy"]).length, 15);
  // An accounting-only tenant still gets a meaningful panel.
  const accountingOnly = rosterForConnectors(["xero"]);
  assert.ok(accountingOnly.length >= 5);
  assert.ok(accountingOnly.every((agent) =>
    agent.connectors.length === 0 || agent.connectors.includes("xero"),
  ));
  // No connectors, no fleet beyond the always-on scan.
  assert.ok(rosterForConnectors([]).length <= 1);
});

test("the distiller recovers headline and key numbers from the card format", () => {
  const distilled = distillProactiveAnswer([
    "## Revenue is up 18% on the prior 13 weeks",
    "",
    "Key numbers",
    "- **Last 13 weeks:** $142,300 — up 18% on the prior 13 weeks",
    "- **Average sale:** $87.10 — up from $81.40",
    "",
    "The analysis follows.",
  ].join("\n"));
  assert.equal(distilled.headline, "Revenue is up 18% on the prior 13 weeks");
  assert.equal(distilled.keyNumbers.length, 2);
  assert.equal(distilled.keyNumbers[0]?.label, "Last 13 weeks");
  assert.match(distilled.keyNumbers[0]?.value ?? "", /\$142,300/u);
  // Degrades to the first substantive line when the format was ignored.
  const plain = distillProactiveAnswer("Sales held steady this month.\n\nMore detail.");
  assert.equal(plain.headline, "Sales held steady this month.");
});

test("routes are same-origin, membership-scoped, and server-distilled", () => {
  assert.match(runRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(findingRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(runRoute, /consumeAlbertRateLimit\("proactive\.run"\)/u);
  assert.match(runRoute, /tenant\.role !== "owner" && tenant\.role !== "manager"/u);
  assert.match(findingRoute, /distillProactiveAnswer\(parsed\.answer\)/u);
  assert.match(findingRoute, /readBoundedJsonBody\(request\)/u);
  assert.match(panelRoute, /Cache-Control": "no-store/u);
  assert.match(repository, /albert_proactive_panel/u);
  assert.match(repository, /albert_proactive_begin_run/u);
  assert.match(repository, /albert_proactive_agent_started/u);
  assert.match(repository, /albert_proactive_agent_completed/u);
  assert.match(repository, /albert_proactive_agent_failed/u);
});

test("the fleet is client-orchestrated through the real codex pipeline", () => {
  assert.match(controller, /fetch\("\/api\/codex-conversation"/u);
  assert.match(controller, /X-Albert-Conversation-Id/u);
  assert.match(controller, /X-Albert-Turn-Id/u);
  assert.match(controller, /action: "started"/u);
  assert.match(controller, /action: "completed"/u);
  assert.match(controller, /action: "failed"/u);
  // The side chat continues the agent's own conversation, streaming SSE.
  assert.match(sideChat, /conversationId: activeConversationId/u);
  assert.match(sideChat, /InsightsStyleTrace/u);
  assert.match(workspace, /startProactiveFleet/u);
  assert.match(workspace, /ProactiveSideChat/u);
});

test("the panel leads with a synthesized morning brief, not fifteen cards", () => {
  // Synthesis is server-built, owner/manager-gated, idempotent, and persisted.
  assert.match(synthesisRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(synthesisRoute, /tenant\.role !== "owner" && tenant\.role !== "manager"/u);
  assert.match(synthesisRoute, /run\.synthesis && !parsed\.force/u);
  assert.match(synthesisRoute, /buildProactiveSynthesis\(/u);
  assert.match(synthesisModule, /verdict/u);
  assert.match(synthesisModule, /quietLine/u);
  assert.match(synthesisModule, /highlights/u);
  assert.match(synthesisMigration, /ADD COLUMN IF NOT EXISTS synthesis jsonb/u);
  assert.match(synthesisMigration, /GRANT EXECUTE ON FUNCTION public\.albert_proactive_record_synthesis\(text, jsonb\) TO authenticated/u);
  assert.match(repository, /albert_proactive_record_synthesis/u);
  // The finished panel renders verdict → highlight bento → collapsed areas.
  assert.match(workspace, /styles\.verdict\b/u);
  assert.match(workspace, /styles\.bentoGrid\b/u);
  assert.match(workspace, /styles\.bentoHero\b/u);
  assert.match(workspace, /styles\.allAreasToggle/u);
  assert.match(workspace, /\/api\/proactive\/synthesis/u);
});

test("the question wall is Luna-written, refreshable, and opens a fresh side chat", () => {
  const questionsRoute = read("app/api/proactive/questions/route.ts");
  const questionModule = read("services/proactive/src/question-bank.ts");
  const bankMigration = read("infra/migrations/control-plane/0160_m6_proactive_question_bank.sql");
  assert.match(questionModule, /QUESTION_BANK_MODEL = "gpt-5\.6-luna"/u);
  assert.match(questionModule, /QUESTION_BANK_REASONING_EFFORT = "max"/u);
  assert.match(questionModule, /QUESTION_BANK_SERVICE_TIER = "fast"/u);
  assert.match(questionModule, /QUESTION_BANK_SIZE = 40/u);
  assert.match(questionsRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(questionsRoute, /tenant\.role !== "owner" && tenant\.role !== "manager"/u);
  assert.match(bankMigration, /CREATE TABLE IF NOT EXISTS control_plane\.proactive_question_bank/u);
  assert.match(bankMigration, /GRANT EXECUTE ON FUNCTION public\.albert_proactive_record_question_bank\(jsonb, text\) TO authenticated/u);
  assert.match(workspace, /styles\.stickerWall/u);
  assert.match(workspace, /\/api\/proactive\/questions/u);
  assert.match(workspace, /conversationId: null/u);
  // A null conversation id makes the side chat mint a fresh codex conversation.
  assert.match(sideChat, /conversationId: string \| null/u);
  assert.match(sideChat, /X-Albert-Conversation-Id/u);
});

test("the migration carries RLS, the rate policy, and the deletion chain", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.proactive_runs/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.proactive_findings/u);
  assert.match(migration, /ALTER TABLE control_plane\.proactive_runs ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE control_plane\.proactive_findings ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /\('proactive\.run', 6, 3600, false\)/u);
  // Connection-scope deletion invalidates proactive rows tenant-wide.
  assert.match(migration, /DELETE FROM control_plane\.proactive_findings WHERE tenant_id = request_row\.tenant_id/u);
  assert.match(migration, /DELETE FROM control_plane\.proactive_runs WHERE tenant_id = request_row\.tenant_id/u);
  for (const fn of [
    "albert_proactive_panel()",
    "albert_proactive_begin_run(text, text, text, jsonb)",
    "albert_proactive_agent_started(text, text, text, text)",
    "albert_proactive_agent_completed(text, text, text, text, text, jsonb, jsonb)",
    "albert_proactive_agent_failed(text, text, text)",
  ]) {
    assert.ok(
      migration.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated`),
      fn,
    );
  }
  assert.match(adr, /client-orchestrated/iu);
});
