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
