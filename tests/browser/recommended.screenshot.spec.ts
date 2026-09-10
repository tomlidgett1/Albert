/**
 * Visual acceptance for "What to look at next" (ADR 0117, ADR 0133): the
 * empty New Analysis page with the composer vertically centred and the
 * daily-look panel below it, in light and dark themes, through the stubbed
 * app harness.
 *
 * Usage:
 *   node scripts/run-browser-acceptance.mjs tests/browser/recommended.screenshot.spec.ts
 */
import { expect, test } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

for (const colorScheme of ["light", "dark"] as const) {
  test(`captures the homepage with the daily look below a centred composer (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await installAppApiRoutes(page, { recentAnalyses: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/dash");
    await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
    const recommended = page.getByRole("region", { name: "What to look at next" });
    await expect(recommended).toBeVisible();
    await expect(recommended.getByRole("button")).toHaveCount(3);
    // Let the entrance settle before measuring and capturing.
    await page.waitForTimeout(800);

    // The composer stays centred in the chat workspace; the panel hangs below it.
    const geometry = await page.evaluate(() => {
      const textbox = document.querySelector<HTMLElement>("form textarea");
      const form = textbox?.closest("form");
      const workspace = form?.closest<HTMLElement>('[class*="chatWorkspace"]');
      const panel = document.querySelector<HTMLElement>('[aria-label="What to look at next"]');
      if (!form || !workspace || !panel) return null;
      const f = form.getBoundingClientRect();
      const w = workspace.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return {
        composerCentre: (f.top + f.bottom) / 2,
        workspaceCentre: (w.top + w.bottom) / 2,
        composerBottom: f.bottom,
        panelTop: p.top,
        panelBottom: p.bottom,
        workspaceBottom: w.bottom,
      };
    });
    expect(geometry).not.toBeNull();
    expect(Math.abs(geometry!.composerCentre - geometry!.workspaceCentre)).toBeLessThan(24);
    expect(geometry!.panelTop).toBeGreaterThan(geometry!.composerBottom);
    expect(geometry!.panelBottom).toBeLessThan(geometry!.workspaceBottom);

    await page.screenshot({ path: `.playwright/recommended-${colorScheme}.png` });
  });
}

function currentLook(now: number, title: string, expiresSoon = false) {
  const end = expiresSoon ? now - 93_600_000 + 2_000 : now;
  return {
    recommendations: [{ id: "daily-test", title, question: "What explains the sales change in the last seven days?", why: "Bike sales fell 11%; labour costs rose 18% against the preceding seven days.", domain: "sales", move: "diagnose", tool: "lightspeed", fromTitle: "Daily look", fromConversationId: null }],
    generatedAt: new Date(end).toISOString(), windowStart: new Date(end - 604_800_000).toISOString(), windowEnd: new Date(end).toISOString(), expiresAt: new Date(end + 93_600_000).toISOString(), timezone: "Australia/Melbourne", source: "daily",
  };
}

test("an open homepage picks up a refreshed look without reloading, even without past chats", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await installAppApiRoutes(page);
  let reads = 0;
  await page.route(/\/api\/recommended-analysis(?:\?.*)?$/u, async route => {
    reads += 1;
    await route.fulfill({ json: currentLook(now, reads === 1 ? "Analyse why bike sales fell 11% this week" : "Investigate the 18% rise in labour costs") });
  });
  await page.goto("/dash");
  const panel = page.getByRole("region", { name: "What to look at next" });
  await expect(panel.getByText("Analyse why bike sales fell 11% this week")).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(panel.getByText("Investigate the 18% rise in labour costs")).toBeVisible();
  await expect(panel.getByText("Analyse why bike sales fell 11% this week")).toHaveCount(0);
});

test("expired recommendations disappear even when the refresh request fails", async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await installAppApiRoutes(page, { recentAnalyses: true });
  let reads = 0;
  await page.route(/\/api\/recommended-analysis(?:\?.*)?$/u, async route => {
    reads += 1;
    if (reads > 1) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    await route.fulfill({ json: currentLook(now, "Analyse why bike sales fell 11% this week", true) });
  });
  await page.goto("/dash");
  const panel = page.getByRole("region", { name: "What to look at next" });
  await expect(panel).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBeGreaterThan(1);
  await page.clock.fastForward(2_100);
  await expect(panel).toHaveCount(0);
});
