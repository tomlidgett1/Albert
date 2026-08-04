import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installAppApiRoutes, installSupabaseBrowserAuthRoutes } from "./support/app-fixtures";

async function openDashboard(page: Parameters<typeof installAppApiRoutes>[0]) {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  return capture;
}

async function openConnections(page: Parameters<typeof installAppApiRoutes>[0]) {
  await page.getByRole("button", { name: /Albert Bike Store account menu/u }).click();
  await page.getByRole("button", { name: "Connections" }).click();
}

async function expectNoWcagViolations(
  page: Parameters<typeof installAppApiRoutes>[0],
  selectedTheme: string,
) {
  await page.evaluate(async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      const transitions = document.getAnimations().filter((animation) => (
        animation.playState === "running"
        && animation.effect?.getTiming().iterations !== Infinity
      ));
      if (transitions.length === 0) return;
      await Promise.allSettled(transitions.map((animation) => animation.finished));
    }
  });
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    scan.violations,
    `${selectedTheme} theme:\n${scan.violations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")}`,
  ).toEqual([]);
}

test.describe("unauthenticated account journey", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign-up preserves organisation metadata and enters email-confirmation state", async ({ page }) => {
    await installSupabaseBrowserAuthRoutes(page);
    await page.goto("/login");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel("Email").fill("new-owner@example.com");
    await page.getByLabel("Organisation name").fill("Northside Cycles");
    await page.getByLabel("Password").fill("SecureOwnerPass123");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText("We sent a confirmation link to new-owner@example.com.")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("finish creating your account");
  });

  test("login presents a safe, accessible error for invalid credentials", async ({ page }) => {
    await installSupabaseBrowserAuthRoutes(page);
    await page.goto("/login");
    await page.getByLabel("Email").fill("invalid@example.com");
    await page.getByLabel("Password").fill("WrongPassword123");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toHaveText(/Email or password is incorrect/u);
    await expect(page).toHaveURL(/\/login$/u);
  });
});

test("light, dark, green, and system themes remain accessible", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openDashboard(page);

  const dash = page.locator("main");
  const accountTrigger = page.getByRole("button", { name: /Albert Bike Store/u }).last();
  await accountTrigger.click();

  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "dark");
  const darkBackground = await dash.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await page.evaluate(() => localStorage.getItem("albert-theme"))).toBe("dark");
  await expectNoWcagViolations(page, "dark");

  await page.getByRole("button", { name: "Green theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "green");
  const greenBackground = await dash.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(greenBackground).toBe("rgb(18, 32, 28)");
  expect(greenBackground).not.toBe(darkBackground);
  expect(await page.evaluate(() => localStorage.getItem("albert-theme"))).toBe("green");
  await expectNoWcagViolations(page, "green");

  await page.getByRole("button", { name: "Light theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "light");
  const lightBackground = await dash.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(lightBackground).not.toBe(darkBackground);
  await expectNoWcagViolations(page, "light");

  await page.getByRole("button", { name: "System theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "system");
  const systemStyles = await dash.evaluate((element) => {
    const styles = getComputedStyle(element);
    return { background: styles.backgroundColor, colorScheme: styles.colorScheme };
  });
  expect(systemStyles.background).toBe(darkBackground);
  expect(systemStyles.colorScheme).toContain("light dark");
  await expectNoWcagViolations(page, "system");
});

test("model, Fast, and reasoning controls bind to the governed request and render an ordered trace", async ({ page }) => {
  const capture = await openDashboard(page);
  const composer = page.getByRole("textbox", { name: "Ask me anything" });
  await composer.focus();

  const settingsTrigger = page.getByTestId("model-run-controls-trigger");
  await expect(settingsTrigger).toBeVisible();
  await expect(settingsTrigger).toBeInViewport();
  await settingsTrigger.click();
  await expect(page.getByRole("dialog", { name: "Model and run settings" })).toBeVisible();
  await expect(page.locator("[data-model-id]")).toHaveCount(3);
  expect(await page.locator("[data-model-id]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-model-id"))
  )).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  await expect(page.locator("[data-reasoning-effort]")).toHaveCount(6);
  expect(await page.locator("[data-reasoning-effort]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-reasoning-effort"))
  )).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  await expect(page.getByRole("radio", { name: /Sol/u })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /Terra/u })).toBeFocused();
  await expect(page.getByRole("radio", { name: /Terra/u })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Fast", exact: true }).click();
  const reasoningCases = ["none", "low", "medium", "high", "xhigh", "max"] as const;
  for (const [index, reasoningEffort] of reasoningCases.entries()) {
    await page.locator(`[data-reasoning-effort="${reasoningEffort}"]`).click();
    await page.keyboard.press("Escape");
    await expect(settingsTrigger).toBeFocused();
    await expect(settingsTrigger).toHaveAttribute(
      "aria-label",
      new RegExp(`Terra, Fast mode, ${reasoningEffort} reasoning`, "u"),
    );

    const message = index === reasoningCases.length - 1
      ? "Which categories performed best last month?"
      : `Verify the ${reasoningEffort} reasoning request binding.`;
    await composer.fill(message);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => capture.conversationPayloads.length).toBe(index + 1);
    expect(capture.conversationPayloads[index]).toMatchObject({
      message,
      preferences: {
        model: "gpt-5.6-terra",
        fastMode: true,
        reasoningEffort,
      },
    });
    await expect(page.locator('[data-event-type="answer"]')).toHaveCount(index + 1);

    if (index < reasoningCases.length - 1) {
      await settingsTrigger.click();
      await expect(page.getByRole("dialog", { name: "Model and run settings" })).toBeVisible();
      await expect(page.getByRole("radio", { name: /Terra/u })).toBeFocused();
    }
  }

  await expect(page.getByText(/Bikes led net sales in July/u).last()).toBeVisible();
  const eventOrder = await page.locator("[data-event-type]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-event-type"))
  );
  const expectedEventOrder = [
    "progress",
    "progress",
    "query",
    "progress",
    "table",
    "chart",
    "validation",
    "narrative",
    "answer",
  ];
  expect(eventOrder).toHaveLength(reasoningCases.length * expectedEventOrder.length);
  expect(eventOrder.slice(-expectedEventOrder.length)).toEqual(expectedEventOrder);
  await expect(page.getByRole("table").last()).toContainText("Workshop");
  await expect(page.getByRole("img", { name: "Net sales by category" }).last()).toBeVisible();
  await expect(page.getByText("golden_fixture_match").last()).toBeVisible();
  await expect(page.getByText("Verified", { exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: "Sources" }).last().click();
  await expect(page.getByRole("heading", { name: "Category performance · July 2026" })).toBeVisible();
  await expect(page.getByText("Lightspeed Retail R-Series sales").last()).toBeVisible();
  await expect(page.getByText("Completed order-line sales excluding GST", { exact: false }).last()).toBeVisible();
  await expect(page.getByText("Local fixture turns do not create production answer artifacts.").last()).toBeVisible();
});

test("keyboard focus follows dash shortcuts, popovers, drawers, lineage, and destructive confirmation", async ({ page }) => {
  await openDashboard(page);

  await page.keyboard.press("Control+KeyK");
  await expect(page.getByRole("textbox", { name: "Search" })).toBeFocused();

  const accountTrigger = page.getByRole("button", { name: /Albert Bike Store/u }).last();
  await accountTrigger.click();
  await expect(page.getByRole("button", { name: "System theme" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(accountTrigger).toBeFocused();

  const composer = page.getByRole("textbox", { name: "Ask me anything" });
  await composer.focus();
  await expect(page.getByRole("button", { name: "New Analysis" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();

  await composer.fill("Show category performance");
  await page.getByRole("button", { name: "Send message" }).click();
  const sourcesTrigger = page.getByRole("button", { name: "Sources" });
  await sourcesTrigger.click();
  await expect(page.getByRole("button", { name: "Close explanation" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sourcesTrigger).toBeFocused();

  await accountTrigger.click();
  await page.getByRole("button", { name: "Connections" }).click();
  const xeroConnections = page.getByLabel("Xero connections");
  const manageTrigger = xeroConnections.getByRole("button", { name: "Manage" });
  await manageTrigger.click();
  await expect(page.getByRole("button", { name: "Close connection settings" })).toBeFocused();
  await page.getByRole("button", { name: "Disconnect and delete" }).click();
  await expect(page.getByRole("button", { name: "Keep connected" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(manageTrigger).toBeFocused();
});

test("Connections supports keyboard navigation, progressive readiness, onboarding review, and account selection", async ({ page }) => {
  const capture = await openDashboard(page);
  await openConnections(page);
  await expect(page.getByRole("heading", { name: "Your business data, coming together" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: /sync progress/u }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Xero" }).first()).toBeVisible();

  const appsTab = page.getByRole("tab", { name: "Apps" });
  await appsTab.focus();
  await page.keyboard.press("ArrowRight");
  const reviewTab = page.getByRole("tab", { name: /Review/u });
  await expect(reviewTab).toBeFocused();
  await expect(reviewTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Independent bicycle retail")).toBeVisible();
  await expect(page.getByText("Should sales normally include or exclude GST?")).toBeVisible();
  await expect(page.getByText("Is this the same employee?")).toBeVisible();

  await appsTab.click();
  await page.getByRole("button", { name: /Albert Workshop Pty Ltd/u }).click();
  await expect.poll(() => capture.oauthSelectionPayloads.length).toBe(1);
  expect(capture.oauthSelectionPayloads[0]).toEqual({
    oauthSessionId: "01J0000000000000000000OS1",
    externalAccountId: "xero-account-2",
  });
});

test("OAuth callback cancellation, invalid response, and unknown provider fail safely without vendor secrets", async ({ page }) => {
  await installAppApiRoutes(page);

  await page.goto("/api/oauth/xero/callback?error=access_denied");
  await expect(page.getByText("Xero authorization was cancelled. Nothing was changed.")).toBeVisible();
  await expect(page).toHaveURL(/\/dash\?view=Connections$/u);

  await page.goto("/api/oauth/deputy/callback");
  await expect(page.getByRole("alert")).toContainText(
    "Deputy returned an invalid or expired authorization response",
  );

  await page.goto("/api/oauth/not-a-provider/callback");
  await expect(page.getByRole("alert")).toContainText("That connection provider is not supported.");
});

test("Connections launches the exact same-origin OAuth start path", async ({ page }) => {
  await openDashboard(page);
  let launch: Readonly<{ method: string; url: string; initiatorOrigin: string }> | undefined;
  await page.route(/\/api\/oauth\/lightspeed\/start$/u, async (route) => {
    launch = {
      method: route.request().method(),
      url: route.request().url(),
      initiatorOrigin: new URL(route.request().frame().url()).origin,
    };
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>OAuth handoff accepted</title><p>Provider handoff boundary reached.</p>",
    });
  });

  await openConnections(page);
  await page.getByLabel("Lightspeed connections").getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Provider handoff boundary reached.")).toBeVisible();
  expect(launch).toEqual({
    method: "GET",
    url: "https://127.0.0.1:3101/api/oauth/lightspeed/start",
    initiatorOrigin: "https://127.0.0.1:3101",
  });
});

test("mobile layout has no page overflow and reduced motion disables analytical animations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDashboard(page);

  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const composer = page.getByRole("textbox", { name: "Ask me anything" });
  await composer.fill("Show category performance");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Bikes led net sales in July/u)).toBeVisible();

  const motion = await page.locator('[data-event-type="table"]').evaluate((element) => ({
    animationName: getComputedStyle(element).animationName,
    animationDuration: getComputedStyle(element).animationDuration,
  }));
  expect(motion.animationName).toBe("none");
  expect(Number.parseFloat(motion.animationDuration)).toBeLessThanOrEqual(0.001);

  await openConnections(page);
  await expect(page.getByRole("heading", { name: "Your business data, coming together" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    sidebarWidth: Math.round(document.querySelector("aside")?.getBoundingClientRect().width ?? 0),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.sidebarWidth).toBe(52);
});
