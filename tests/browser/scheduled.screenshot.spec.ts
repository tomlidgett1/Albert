/**
 * Visual acceptance for the Scheduled surface (ADR 0131): the composer, a
 * listed schedule and a freshly created one, in light and dark themes and
 * on a narrow screen, through the stubbed app harness.
 *
 * Usage:
 *   node scripts/run-browser-acceptance.mjs tests/browser/scheduled.screenshot.spec.ts
 */
import { expect, test } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

for (const colorScheme of ["light", "dark"] as const) {
  test(`captures the Scheduled surface (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await installAppApiRoutes(page);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/dash");
    await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
    await page.getByRole("tab", { name: "Scheduled" }).click();
    await expect(page.getByTestId("scheduled-task").first()).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `.playwright/scheduled-list-${colorScheme}.png` });

    await page.getByRole("textbox", { name: "Describe a report and when to send it" })
      .fill("Every Monday at 8:30am text me last week's sales vs the week before");
    await page.getByRole("button", { name: "Create schedule" }).click();
    await expect(page.getByTestId("scheduled-task")).toHaveCount(2);
    await page.getByTestId("scheduled-task").nth(1).getByRole("button", { name: "Run now" }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `.playwright/scheduled-created-${colorScheme}.png`, fullPage: true });
  });
}

test("captures the Scheduled surface on a narrow screen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await installAppApiRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dash");
  await page.getByRole("tab", { name: "Scheduled" }).click();
  await expect(page.getByTestId("scheduled-task").first()).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: ".playwright/scheduled-narrow.png", fullPage: true });
});
