/**
 * Renders a real built dashboard document through the stubbed app harness and
 * captures a full-page screenshot — the visual acceptance for a production
 * natural-language build without needing an authenticated browser login.
 *
 * Skipped unless DASHBOARD_DOC_JSON points at a dashboard-document.json
 * produced by scripts/albert-eval/run-dashboard-build.mts (--apply) or a
 * direct albert_dashboard_get dump. The screenshot lands next to the
 * document as dashboard-build.png.
 *
 * Usage:
 *   DASHBOARD_DOC_JSON=evals/albert/runs/dashboard-build-live/dashboard-document.json \
 *     node scripts/run-browser-acceptance.mjs -g "renders a real built dashboard"
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

const documentPath = process.env.DASHBOARD_DOC_JSON;

test("renders a real built dashboard", async ({ page }) => {
  test.skip(!documentPath, "DASHBOARD_DOC_JSON not set");
  const dashboard = JSON.parse(readFileSync(documentPath!, "utf8")) as Record<string, unknown>;

  await installAppApiRoutes(page);
  // Override the fixture dashboard with the real applied document.
  await page.route(/\/api\/dashboard$/u, async (route) => {
    await route.fulfill({ json: { dashboard } });
  });
  await page.route(/\/api\/dashboard\/refresh$/u, async (route) => {
    await route.fulfill({ json: { dashboard, refreshedTileIds: [] } });
  });

  await page.goto("/dash");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const tiles = Array.isArray(dashboard.tiles) ? dashboard.tiles : [];
  expect(tiles.length).toBeGreaterThan(0);
  const firstTitle = String((tiles[0] as Record<string, unknown>).title);
  await expect(page.getByRole("region", { name: firstTitle, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 2400 });
  // Give the Flint charts a beat to draw their SVGs before capturing.
  await page.waitForTimeout(5_000);
  const out = path.join(path.dirname(documentPath!), "dashboard-build.png");
  await page.screenshot({ path: out, fullPage: true });
  console.log(`screenshot → ${out}`);
});
