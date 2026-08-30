/**
 * Renders a real Dashboard Master report document through the stubbed app
 * harness and captures a full-page screenshot — the visual acceptance for a
 * production session without needing an authenticated browser login.
 *
 * Skipped unless DM_REPORT_JSON points at a report.json produced by
 * scripts/albert-eval/run-dashboard-master.mts. The screenshot lands next to
 * the report as dashboard.png.
 *
 * Usage:
 *   DM_REPORT_JSON=evals/albert/runs/dm-ashburton-1/report.json \
 *     node scripts/run-browser-acceptance.mjs -g "renders a real Dashboard Master report"
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

const reportPath = process.env.DM_REPORT_JSON;

test("renders a real Dashboard Master report", async ({ page }) => {
  test.skip(!reportPath, "DM_REPORT_JSON not set");
  const report = JSON.parse(readFileSync(reportPath!, "utf8")) as Record<string, unknown>;

  await installAppApiRoutes(page);
  // Override the fixture panel with the real report document.
  await page.route(/\/api\/dashboard-master(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        latest: {
          reportId: report.reportId,
          status: "completed",
          model: report.model,
          reasoningEffort: "max",
          startedAt: report.generatedAt,
          completedAt: report.generatedAt,
          report,
          failureNote: null,
        },
        running: null,
        conversationIds: [],
        refreshDue: false,
        canRun: true,
      },
    });
  });

  await page.goto("/dash");
  await page.getByRole("button", { name: "Dashboard Master" }).click();
  await expect(page.getByRole("heading", { name: String(report.headline) })).toBeVisible();
  // Give the Flint charts a beat to draw their SVGs before capturing.
  await page.waitForTimeout(4_000);
  const out = path.join(path.dirname(reportPath!), "dashboard.png");
  await page.screenshot({ path: out, fullPage: true });
  console.log(`screenshot → ${out}`);
});
