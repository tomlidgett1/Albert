/**
 * Replays real Omni turns through the stubbed app harness and captures each
 * answer exactly as the owner sees it: the working trail, the prose, the
 * tables and the footnote, at the chat column's real width. The visual
 * companion to scripts/albert-eval/style-metrics.mts — a metric can say an
 * answer is short, only a screenshot shows whether it reads well.
 *
 * Skipped unless OMNI_ANSWER_RUN names a run produced by
 * scripts/albert-eval/run-omni.mts. Screenshots land in that run's screens/
 * folder, one per turn id.
 *
 * Usage:
 *   OMNI_ANSWER_RUN=style-after OMNI_ANSWER_IDS=ST-05,ST-10 \
 *     node scripts/run-browser-acceptance.mjs -g "renders real Omni answers"
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

const run = process.env.OMNI_ANSWER_RUN;
const runDir = run ? path.resolve("evals/albert/runs", run) : "";
const wanted = new Set((process.env.OMNI_ANSWER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));

type TurnRecord = { id: string; question: string; answerText?: string };

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

test("renders real Omni answers", async ({ page }) => {
  test.skip(!run || !existsSync(path.join(runDir, "results.jsonl")), "OMNI_ANSWER_RUN not set");
  test.setTimeout(240_000);
  const latest = new Map<string, TurnRecord>();
  for (const record of readJsonl<TurnRecord>(path.join(runDir, "results.jsonl"))) latest.set(record.id, record);
  const turns = [...latest.values()].filter((record) => record.answerText && (wanted.size === 0 || wanted.has(record.id)));
  expect(turns.length).toBeGreaterThan(0);
  const screens = path.join(runDir, "screens");
  mkdirSync(screens, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1100 });

  for (const turn of turns) {
    const eventsFile = readdirSync(path.join(runDir, "events")).filter((name) => name.startsWith(`${turn.id}.`)).sort().at(-1);
    expect(eventsFile, `events for ${turn.id}`).toBeTruthy();
    const started = Date.parse("2026-09-19T00:00:00.000Z");
    // The runtime's events carry no id or sequence — the web relay stamps
    // them — so stamp them the same way before replaying.
    const events = readJsonl<Record<string, unknown> & { atMs?: number }>(path.join(runDir, "events", eventsFile!))
      .map((event, index) => ({ ...event, id: `replay_${index + 1}`, sequence: index + 1, occurredAt: new Date(started + (event.atMs ?? index * 1_000)).toISOString() }));

    await installAppApiRoutes(page);
    await page.route(/\/api\/omni-conversation$/u, async (route) => {
      // The client refuses a reply whose model differs from the one it asked for.
      const preferences = (route.request().postDataJSON() as { preferences?: { model?: unknown } } | null)?.preferences;
      const model = typeof preferences?.model === "string" ? preferences.model : "gpt-5.6-luna";
      await route.fulfill({
        status: 200,
        body: events.map((event) => `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Albert-Runtime": "omni",
          "X-Albert-Model": model,
          "X-Albert-Conversation-Id": "01J00000000000000000000041",
          "X-Albert-Turn-Id": "01J00000000000000000000042",
        },
      });
    });

    await page.goto("/dash");
    const composer = page.getByRole("textbox", { name: "Ask Omni about your business" });
    await composer.fill(turn.question);
    await composer.press("Enter");
    // The opening words of the answer prove the final message rendered.
    const opening = turn.answerText!.replace(/[*#|`]/gu, "").split("\n").find((line) => line.trim())!.trim().split(/\s+/u).slice(0, 4).join(" ");
    await expect(page.getByText(opening, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_200);
    const out = path.join(screens, `${turn.id}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`screenshot → ${out}`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
