/**
 * Visual acceptance for the Discover surface (ADR 0130): captures the chat
 * header with the Chat / Discover slider and the Discover grid in light and
 * dark themes through the stubbed app harness.
 *
 * Usage:
 *   node scripts/run-browser-acceptance.mjs tests/browser/discover.screenshot.spec.ts
 */
import { expect, test } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

for (const colorScheme of ["light", "dark"] as const) {
  test(`captures the Discover surface (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await installAppApiRoutes(page);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/dash");
    await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
    await page.screenshot({ path: `.playwright/discover-chat-${colorScheme}.png` });

    await page.getByRole("tab", { name: "Discover" }).click();
    await expect(page.getByTestId("discover-card").first()).toBeVisible();
    // Let the staggered entrance settle before capturing.
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: `.playwright/discover-grid-${colorScheme}.png` });

    // Run settings live in the composer, which only the Chat surface renders.
    await page.getByRole("tab", { name: "Chat" }).click();
    await page.getByTestId("model-run-controls-trigger").click();
    await expect(page.getByRole("switch", { name: "Raw debugger" })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `.playwright/discover-run-settings-${colorScheme}.png` });
  });
}

test("captures the Discover surface on a narrow screen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await installAppApiRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dash");
  await page.getByRole("tab", { name: "Discover" }).click();
  await expect(page.getByTestId("discover-card").first()).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: ".playwright/discover-grid-narrow.png" });
});
