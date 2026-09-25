import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installAppApiRoutes } from "./support/app-fixtures";

async function openDashboard(page: Page) {
  await page.goto("/dash");
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await page
    .getByRole("list", { name: "Your dashboards" })
    .getByRole("button", { name: /^Ashburton at a glance/ })
    .click();
  const pivot = page.getByRole("region", {
    name: "Weekly scorecard",
    exact: true,
  });
  await pivot
    .getByRole("button", { name: "Properties for Weekly scorecard" })
    .click();
  return {
    pivot,
    editor: page.getByRole("complementary", {
      name: "Element editor for Weekly scorecard",
    }),
  };
}

test("pivot editor docks on selection, drags Values between axes, and persists across reopen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const capture = await installAppApiRoutes(page, { dashboardApplied: true });
  const { pivot, editor } = await openDashboard(page);
  await expect(
    editor.getByRole("group", { name: "Pivot rows", exact: true }),
  ).toContainText("Values");
  await expect(
    editor.getByRole("group", { name: "Pivot columns", exact: true }),
  ).toContainText("Period");
  await expect(pivot.getByRole("cell", { name: /Sales, 27 Jul:/ })).toHaveText(
    "$8,379.02",
  );
  const valueField = editor.locator('[data-field-key="__values__"]');
  await valueField.dragTo(
    editor.getByRole("group", { name: "Pivot columns", exact: true }),
  );
  await expect(
    editor.getByRole("group", { name: "Pivot rows", exact: true }),
  ).toContainText("Drag columns here");
  await expect(
    editor.getByRole("group", { name: "Pivot columns", exact: true }),
  ).toContainText("Values");
  await expect
    .poll(
      () =>
        capture.dashboardBuildPayloads.filter(
          (entry: unknown) =>
            (entry as { endpoint: string }).endpoint === "tile",
        ).length,
    )
    .toBe(1);
  // A move is one display PATCH, never an Omni request or a query rewrite.
  expect(capture.omniConversationPayloads).toHaveLength(0);
  expect(
    capture.dashboardBuildPayloads.filter(
      (entry: unknown) => (entry as { endpoint: string }).endpoint === "query",
    ),
  ).toHaveLength(0);
  await page.reload();
  const reopened = await openDashboard(page);
  await expect(
    reopened.editor.getByRole("group", { name: "Pivot columns", exact: true }),
  ).toContainText("Values");
  await reopened.editor
    .getByRole("button", { name: "Swap rows with columns", exact: true })
    .click();
  await expect(
    reopened.editor.getByRole("group", { name: "Pivot rows", exact: true }),
  ).toContainText("Period");
  await reopened.pivot
    .getByRole("button", { name: "Maximize element", exact: true })
    .click();
  await page.mouse.move(600, 100);
  await page.screenshot({
    path: ".playwright/pivot-editor-light.png",
    fullPage: true,
  });
});

test("pivot field menus reorder measures, change aggregation, and apply table formatting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await installAppApiRoutes(page, { dashboardApplied: true });
  const { pivot, editor } = await openDashboard(page);
  await editor
    .getByRole("button", {
      name: "Options for Transactions in Values",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect(
    editor
      .getByRole("group", { name: "Values", exact: true })
      .locator("[data-field-key]")
      .nth(1),
  ).toHaveAttribute("data-field-key", "__metric_2");
  await editor
    .getByRole("button", { name: "Options for Sales in Values", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Set aggregate", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "Sum", exact: true }).click();
  await expect(
    editor.getByRole("group", { name: "Values", exact: true }),
  ).toContainText("Sum of Sales");
  await editor.getByRole("tab", { name: "Format", exact: true }).click();
  await editor
    .getByRole("switch", { name: "Grand total column", exact: true })
    .check();
  await expect(
    pivot.getByRole("cell", { name: /Sum of Sales, Grand total:/ }),
  ).toHaveText("$26,791.25");
  await editor
    .getByRole("combobox", { name: "Decimal places", exact: true })
    .selectOption("0");
  await expect(
    pivot.getByRole("cell", { name: /Sum of Sales, Grand total:/ }),
  ).toHaveText("$26,791");
  await editor
    .getByRole("combobox", { name: "Cell spacing", exact: true })
    .selectOption("large");
  await expect(pivot.locator('[data-density="large"]')).toBeVisible();
  await editor.getByRole("button", { name: "Change element type" }).click();
  await page.getByRole("menuitemradio", { name: "Table", exact: true }).click();
  await expect(pivot.locator("table[data-pivot]")).toHaveCount(0);
  await expect(
    pivot.getByRole("columnheader", { name: "Row number" }),
  ).toHaveCount(0);
});

test("pivot rail and portalled menus support system dark, compact screens and keyboard navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 960 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await installAppApiRoutes(page, { dashboardApplied: true });
  const { editor } = await openDashboard(page);
  await editor.getByRole("tab", { name: "Properties", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    editor.getByRole("tab", { name: "Format", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await editor
    .getByRole("button", { name: "Options for Sales in Values", exact: true })
    .click();
  const menu = page.getByRole("menu", { name: "Sales field options" });
  const background = await menu.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(background).not.toBe("rgb(255, 255, 255)");
  await page.screenshot({
    path: ".playwright/pivot-editor-dark.png",
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-label="Element editor for Weekly scorecard"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await editor.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".playwright/pivot-editor-mobile.png",
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Close element editor" }).click();
  await expect(editor).toHaveCount(0);
});

test("dashboard button uses Omni and opens the pivot editor in the expandable preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");
  await page
    .getByRole("button", { name: "Dashboard mode", exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: "Describe the dashboard you want",
  });
  await input.fill("Build a dashboard with a weekly sales scorecard");
  await input.press("Enter");
  const panel = page.getByRole("complementary", {
    name: "Dashboard preview",
    exact: true,
  });
  await expect(panel.getByText("Live", { exact: true })).toBeVisible();
  await panel
    .getByRole("button", { name: "Expand dashboard", exact: true })
    .click();
  const pivot = panel.getByRole("region", {
    name: "Weekly scorecard",
    exact: true,
  });
  await pivot
    .getByRole("button", {
      name: "Properties for Weekly scorecard",
      exact: true,
    })
    .click();
  await pivot
    .getByRole("button", { name: "Maximize element", exact: true })
    .click();
  const editor = panel.getByRole("complementary", {
    name: "Element editor for Weekly scorecard",
    exact: true,
  });
  await expect(
    editor.getByRole("group", { name: "Pivot rows", exact: true }),
  ).toContainText("Values");
  await editor
    .getByRole("button", { name: "Swap rows with columns", exact: true })
    .click();
  await expect(
    editor.getByRole("group", { name: "Pivot rows", exact: true }),
  ).toContainText("Period");
  expect(
    capture.omniConversationPayloads.filter(
      (payload) =>
        (payload as { dashboardBuild?: boolean }).dashboardBuild === true,
    ),
  ).toHaveLength(1);
  await page.mouse.move(600, 100);
  await page.screenshot({
    path: ".playwright/pivot-editor-omni-dashboard.png",
    fullPage: true,
  });
  await panel
    .getByRole("button", { name: "Return to dashboard chat", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: /Ask for changes to your dashboard|Describe the dashboard you want/,
    }),
  ).toBeVisible();
});

test("failed pivot saves restore the saved arrangement and explain the failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await installAppApiRoutes(page, { dashboardApplied: true });
  const { pivot, editor } = await openDashboard(page);
  await page.route(
    "**/api/dashboard/tiles/01J00000000000000000DBT501",
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: "The pivot settings could not be saved. Please try again.",
        },
      }),
    { times: 1 },
  );
  await editor
    .getByRole("button", { name: "Swap rows with columns", exact: true })
    .click();
  await expect(pivot.getByRole("alert")).toContainText("could not be saved");
  await expect(
    editor.getByRole("group", { name: "Pivot rows", exact: true }),
  ).toContainText("Values");
  await editor
    .getByRole("button", { name: "Swap rows with columns", exact: true })
    .click();
  await expect(
    editor.getByRole("group", { name: "Pivot rows", exact: true }),
  ).toContainText("Period");
  await expect(pivot.getByRole("alert")).toHaveCount(0);
});

test("source columns drag onto pivot shelves and nested rows expand with separate labels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await installAppApiRoutes(page, { dashboardApplied: true });
  const { pivot, editor } = await openDashboard(page);
  await pivot
    .getByRole("button", { name: "Maximize element", exact: true })
    .click();
  const rows = editor.getByRole("group", { name: "Pivot rows", exact: true });
  await editor
    .locator('[data-field-key="__period__"][data-field-shelf="source"]')
    .dragTo(rows);
  await expect(rows).toContainText("Period");
  await expect(
    editor.getByRole("group", { name: "Pivot columns", exact: true }),
  ).toContainText("Drag columns here");
  await editor
    .getByRole("button", { name: "Display as separate columns", exact: true })
    .click();
  await expect(
    pivot.getByRole("columnheader", { name: /Period/ }),
  ).toBeVisible();
  const collapse = pivot.getByRole("button", {
    name: "Collapse 27 Jul",
    exact: true,
  });
  const before = await pivot.locator("tbody tr").count();
  await collapse.click();
  await expect(pivot.locator("tbody tr")).toHaveCount(before - 3);
  await pivot
    .getByRole("button", { name: "Expand 27 Jul", exact: true })
    .click();
  await expect(pivot.locator("tbody tr")).toHaveCount(before);
  await expect(pivot.getByRole("alert")).toHaveCount(0);
});
