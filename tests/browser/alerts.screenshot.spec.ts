/**
 * Visual acceptance for the Alerts surface (ADR 0132): the ten trigger
 * cards with their recipients, the status line and the Recent list, in
 * light and dark themes and on a narrow screen, through the stubbed app
 * harness.
 *
 * Usage:
 *   node scripts/run-browser-acceptance.mjs tests/browser/alerts.screenshot.spec.ts
 */
import { expect, test } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

for (const colorScheme of ["light", "dark"] as const) {
  test(`captures the Alerts surface (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await installAppApiRoutes(page);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/dash");
    await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
    await page.getByRole("tab", { name: "Alerts" }).click();
    await expect(page.getByTestId("alerts-trigger")).toHaveCount(10);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `.playwright/alerts-${colorScheme}.png` });
    await page.screenshot({ path: `.playwright/alerts-${colorScheme}-full.png`, fullPage: true });
  });
}

test("captures the Alerts surface on a narrow screen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await installAppApiRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dash");
  await page.getByRole("tab", { name: "Alerts" }).click();
  await expect(page.getByTestId("alerts-trigger")).toHaveCount(10);
  await page.waitForTimeout(800);
  await page.screenshot({ path: ".playwright/alerts-narrow.png", fullPage: true });
});
