import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  installAppApiRoutes,
  installSupabaseBrowserAuthRoutes,
} from "./support/app-fixtures";

async function openDashboard(page: Parameters<typeof installAppApiRoutes>[0]) {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");
  await expect(
    page.getByRole("heading", { name: "New Analysis", level: 1 }),
  ).toBeVisible();
  return capture;
}

function analysisRuntimeTrigger(
  page: Parameters<typeof installAppApiRoutes>[0],
  runtime?: "Albert" | "Codex" | "Omni" | "Compare",
) {
  return runtime
    ? page.getByRole("button", { name: `Analysis runtime: ${runtime}` })
    : page.getByRole("button", { name: /Analysis runtime:/u });
}

async function selectAnalysisRuntime(
  page: Parameters<typeof installAppApiRoutes>[0],
  runtime: "Albert" | "Codex" | "Omni" | "Compare",
) {
  const trigger = analysisRuntimeTrigger(page);
  if (await trigger.getAttribute("aria-expanded") !== "true") {
    await trigger.click();
  }
  const option = runtime === "Codex"
    ? page.getByRole("menuitemradio", { name: /Codex/u })
    : page.getByRole("menuitemradio", { name: runtime, exact: true });
  await option.click();
}

async function openAlbertChat(page: Parameters<typeof installAppApiRoutes>[0]) {
  await selectAnalysisRuntime(page, "Albert");
  await expect(page.getByRole("textbox", { name: "Ask me anything" })).toBeVisible();
}

async function openConnections(
  page: Parameters<typeof installAppApiRoutes>[0],
) {
  await page
    .getByRole("button", { name: /Albert Bike Store account menu/u })
    .click();
  await page.getByRole("button", { name: "Connections" }).click();
}

async function expectNoWcagViolations(
  page: Parameters<typeof installAppApiRoutes>[0],
  selectedTheme: string,
) {
  await page.evaluate(async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      const transitions = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations !== Infinity,
        );
      if (transitions.length === 0) return;
      await Promise.allSettled(
        transitions.map((animation) => animation.finished),
      );
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

  test("sign-up preserves organisation metadata and enters email-confirmation state", async ({
    page,
  }) => {
    await installSupabaseBrowserAuthRoutes(page);
    await page.goto("/login");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel("Email").fill("new-owner@example.com");
    await page.getByLabel("Organisation name").fill("Northside Cycles");
    await page.getByLabel("Password").fill("SecureOwnerPass123");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await expect(
      page.getByText("We sent a confirmation link to new-owner@example.com."),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "finish creating your account",
    );
  });

  test("login presents a safe, accessible error for invalid credentials", async ({
    page,
  }) => {
    await installSupabaseBrowserAuthRoutes(page);
    await page.goto("/login");
    await page.getByLabel("Email").fill("invalid@example.com");
    await page.getByLabel("Password").fill("WrongPassword123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("alert")).toHaveText(
      /Email or password is incorrect/u,
    );
    await expect(page).toHaveURL(/\/login$/u);
  });
});

test("light, beige, dark, green, and system themes remain accessible", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openDashboard(page);

  const dash = page.locator("main");
  const accountTrigger = page
    .getByRole("button", { name: /Albert Bike Store/u })
    .last();
  await accountTrigger.click();

  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "dark");
  const darkBackground = await dash.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(await page.evaluate(() => localStorage.getItem("albert-theme"))).toBe(
    "dark",
  );
  await expectNoWcagViolations(page, "dark");

  await page.getByRole("button", { name: "Green theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "green");
  const greenBackground = await dash.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(greenBackground).toBe("rgb(27, 44, 39)");
  expect(greenBackground).not.toBe(darkBackground);
  expect(await page.evaluate(() => localStorage.getItem("albert-theme"))).toBe(
    "green",
  );
  await expectNoWcagViolations(page, "green");

  await page.getByRole("button", { name: "Sage theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "sage");
  const sageBackground = await dash.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(sageBackground).toBe("rgb(220, 232, 203)");
  expect(sageBackground).not.toBe(darkBackground);
  expect(sageBackground).not.toBe(greenBackground);
  expect(await page.evaluate(() => localStorage.getItem("albert-theme"))).toBe(
    "sage",
  );
  await expectNoWcagViolations(page, "sage");

  await page.getByRole("button", { name: "Beige theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "beige");
  const beigeBackground = await dash.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(beigeBackground).toBe("rgb(240, 238, 230)");
  expect(beigeBackground).not.toBe(darkBackground);
  expect(beigeBackground).not.toBe(greenBackground);
  expect(beigeBackground).not.toBe(sageBackground);
  expect(await page.evaluate(() => localStorage.getItem("albert-theme"))).toBe(
    "beige",
  );
  await expectNoWcagViolations(page, "beige");

  await page.getByRole("button", { name: "Light theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "light");
  const lightBackground = await dash.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(lightBackground).not.toBe(darkBackground);
  await expectNoWcagViolations(page, "light");

  await page.getByRole("button", { name: "System theme" }).click();
  await expect(dash).toHaveAttribute("data-theme", "system");
  const systemStyles = await dash.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      background: styles.backgroundColor,
      colorScheme: styles.colorScheme,
    };
  });
  expect(systemStyles.background).toBe(darkBackground);
  expect(systemStyles.colorScheme).toContain("light dark");
  await expectNoWcagViolations(page, "system");
});

test("homepage recommends next questions from previous conversation results", async ({
  page,
}) => {
  const capture = await installAppApiRoutes(page, { recentAnalyses: true });
  await page.goto("/dash");
  const recommended = page.getByRole("region", { name: "What to look at next" });
  await expect(recommended).toBeVisible();
  await expect(recommended.getByRole("heading", { name: "What to look at next" })).toBeVisible();
  await expect(recommended.getByText("You've looked at sales and customers recently.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent analysis" })).toHaveCount(0);
  await expect(recommended.getByRole("button", {
    name: "Ask: Which products dragged Wednesday's sales last week?",
  })).toBeVisible();
  await expect(recommended.getByRole("button", {
    name: "Ask: What is dragging parts margin: mix, discounting, or cost?",
  })).toBeVisible();
  await expect(recommended.getByText("Did last week's takings reach the bank", { exact: false })).toBeVisible();

  await recommended.getByRole("button", {
    name: "Ask: Which products dragged Wednesday's sales last week?",
  }).click();
  await expect(page.getByRole("region", { name: "What to look at next" })).toHaveCount(0);
  await expect.poll(() => capture.conversationPayloads.length + capture.codexConversationPayloads.length).toBeGreaterThan(0);
  const sent = [...capture.conversationPayloads, ...capture.codexConversationPayloads][0] as {
    message?: string;
  };
  expect(sent.message).toBe("Which products dragged Wednesday's sales last week?");
});

test("homepage keeps history in the sidebar instead of a second card grid", async ({
  page,
}) => {
  await installAppApiRoutes(page, { recentAnalyses: true });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "Ask about your business", level: 2 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent analysis" })).toHaveCount(0);
  const conversations = page.getByRole("navigation", { name: "Conversations" });
  await expect(conversations.getByRole("button", { name: "Weekly sales trend" })).toBeVisible();

  await conversations.getByRole("button", { name: "Weekly sales trend" }).click();
  await expect(page.getByRole("heading", { name: "Ask about your business", level: 2 })).toHaveCount(0);
  await expect(page.getByText("How did this week compare to last week?")).toBeVisible();
});

test("the Agents workspace stays visible while saved Customer Agent conversations remain usable", async ({
  page,
}) => {
  const capture = await installAppApiRoutes(page, { specialistHistory: true });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Test chart", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Customer review", exact: true }).click();
  await expect(page.getByText("Customers · Albert Bike Store", { exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Ask the Customer Agent" });
  await expect(composer).toHaveAttribute("placeholder", "Ask a follow-up about your customers…");
  await composer.fill("Give me a quick pulse check on the customer base.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => capture.conversationPayloads.length).toBe(1);
  expect(capture.conversationPayloads[0]).toMatchObject({
    message: "Give me a quick pulse check on the customer base.",
    specialistAgentId: "customers",
  });

  await page.getByRole("button", { name: "New Analysis", exact: true }).click();
  await expect(page.getByText("Customers · Albert Bike Store", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ask about your business", level: 2 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask Codex about your business" })).toHaveAttribute(
    "placeholder",
    "Ask Codex anything about your connected data…",
  );
});

test("saved Customer Agent conversations restore their specialist context", async ({ page }) => {
  await installAppApiRoutes(page, { specialistHistory: true });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Customer review", exact: true }).click();

  await expect(page.getByText("Customers · Albert Bike Store", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask the Customer Agent" })).toHaveAttribute(
    "placeholder",
    "Ask a follow-up about your customers…",
  );
});

test("Codex is the default harness and Albert remains available", async ({ page }) => {
  const capture = await openDashboard(page);
  await expect(analysisRuntimeTrigger(page, "Codex")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ask about your business", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Suggested investigations" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask Codex about your business" })).toHaveAttribute(
    "placeholder",
    "Ask Codex anything about your connected data…",
  );
  const codexSettings = page.getByTestId("model-run-controls-trigger");
  await expect(codexSettings).toHaveAttribute(
    "aria-label",
    "Run settings: GPT 5.6 Luna, Fast mode, max reasoning, Pro reasoning off, Sol planner on",
  );
  await codexSettings.click();
  await expect(page.getByRole("radio", { name: "GPT 5.6 Luna" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "GPT 5.6 Terra" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "GPT 5.6 Sol" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Grok 4.6" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Claude Haiku 4.5" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const prompt = "Find one high-confidence opportunity I could test this month";
  await page.getByRole("button", { name: "Suggested investigations" }).click();
  await page.getByRole("menuitem", { name: prompt, exact: true }).click();
  await expect.poll(() => capture.codexConversationPayloads.length).toBe(1);
  const codexPlan = page.getByLabel("Plan", { exact: true });
  await expect(codexPlan).toBeVisible();
  await expect(codexPlan.getByText("Find the governed sales view", { exact: true })).toBeVisible();
  await expect(codexPlan.getByText("3/3", { exact: true })).toBeVisible();
  await expect(page.getByText("Bikes led category net sales at $84,240.00.")).toBeVisible();
  await expect(page.getByText("Net sales by category", { exact: true })).toBeVisible();
  await expect(page.getByText(/\{"state"/u)).toHaveCount(0);
  expect(capture.codexConversationPayloads[0]).toEqual({
    message: prompt,
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: true },
    proMode: false,
    solPlanner: true,
  });
  expect(capture.conversationPayloads).toHaveLength(0);

  await selectAnalysisRuntime(page, "Albert");
  await expect(analysisRuntimeTrigger(page, "Albert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ask me anything", level: 2 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask me anything" })).toHaveAttribute(
    "placeholder",
    "Ask anything about your business…",
  );
});

test("Codex reasoning summaries stream in an accessible slide-out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const capture = await openDashboard(page);

  const prompt = "Which categories performed best last month?";
  await page.getByRole("textbox", { name: "Ask Codex about your business" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => capture.codexConversationPayloads.length).toBe(1);

  const reasoningToggle = page.getByRole("button", { name: "Show reasoning" });
  await expect(reasoningToggle).toBeVisible();
  await reasoningToggle.click();
  await expect(page.getByRole("button", { name: "Hide reasoning" })).toHaveAttribute("aria-pressed", "true");

  const drawer = page.locator('aside[aria-label="Reasoning"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Reasoning", level: 2 })).toBeVisible();
  await expect(drawer.getByText("OpenAI’s live reasoning summary.", { exact: false })).toBeVisible();
  await expect(drawer.getByText("Private chain-of-thought stays hidden.", { exact: false })).toBeVisible();
  await expect(drawer.getByText(
    "I compared category performance, checked the strongest alternative explanations, and verified the leading result against the governed evidence.",
    { exact: true },
  )).toBeVisible();

  const layout = await drawer.evaluate((element) => ({
    innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    drawerWidth: element.getBoundingClientRect().width,
    runningAnimations: element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running").length,
  }));
  expect(layout.drawerWidth).toBeLessThanOrEqual(layout.innerWidth);
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.runningAnimations).toBe(0);
  const scan = await new AxeBuilder({ page })
    .include('aside[aria-label="Reasoning"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    scan.violations,
    `Codex reasoning compact dark:\n${scan.violations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")}`,
  ).toEqual([]);

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const lightScan = await new AxeBuilder({ page })
    .include('aside[aria-label="Reasoning"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    lightScan.violations,
    `Codex reasoning compact light:\n${lightScan.violations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")}`,
  ).toEqual([]);
});

test("Swarm selection atomically routes an immediate Pro and Sol send", async ({ page }) => {
  const capture = await openDashboard(page);
  const settings = page.getByTestId("model-run-controls-trigger");
  await settings.click();
  const proReasoning = page.getByRole("switch", { name: "Pro reasoning" });
  await proReasoning.click();
  await expect(proReasoning).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  const prompt = "We need to pay out 1500AUD per month to owners. What can we do to make this in extra GP per month.";
  await page.getByRole("textbox", { name: "Ask Codex about your business" }).fill(prompt);
  await page.evaluate(() => {
    const swarm = document.querySelector<HTMLButtonElement>('button[aria-label="Swarm"]');
    const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    if (!swarm || !send) throw new Error("Swarm test controls were unavailable.");
    // Deliberately submit in the same browser task. React effects cannot run
    // between these clicks, which is the production race this test guards.
    swarm.click();
    send.click();
  });

  await expect.poll(() => capture.swarmPayloads.length).toBe(1);
  expect(capture.swarmPayloads[0]).toEqual({
    message: prompt,
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: true },
    solPlanner: true,
    proMode: true,
  });
  expect(capture.codexConversationPayloads).toHaveLength(0);
});

test("Super agent atomically sends the profitability test with its fixed deep profile", async ({ page }) => {
  const capture = await openDashboard(page);
  const prompt = "How can we improve profitability?";
  await page.getByRole("textbox", { name: "Ask Codex about your business" }).fill(prompt);
  await page.evaluate(() => {
    const superAgent = document.querySelector<HTMLButtonElement>('button[aria-label="Super agent"]');
    const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    if (!superAgent || !send) throw new Error("Super agent test controls were unavailable.");
    superAgent.click();
    send.click();
  });

  await expect.poll(() => capture.swarmPayloads.length).toBe(1);
  expect(capture.swarmPayloads[0]).toEqual({
    message: prompt,
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false },
    solPlanner: true,
    proMode: true,
    kind: "super-agent",
  });
  expect(capture.codexConversationPayloads).toHaveLength(0);
  await expect(page.getByRole("complementary", { name: "Super agent" })).toBeVisible();
  await expect(page.getByText("45-minute deep-work budget", { exact: true })).toBeVisible();
  await expect(page.getByText("updates every 2 minutes", { exact: false })).toBeVisible();
});

test("Codex model controls allow a reviewed OpenAI model change", async ({ page }) => {
  const capture = await openDashboard(page);
  const settings = page.getByTestId("model-run-controls-trigger");
  await settings.click();
  await page.getByRole("radio", { name: "GPT 5.6 Terra" }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveAttribute(
    "aria-label",
    "Run settings: GPT 5.6 Terra, Fast mode, max reasoning, Pro reasoning off, Sol planner on",
  );
  await page.getByRole("textbox", { name: "Ask Codex about your business" }).fill("Show customer health");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => capture.codexConversationPayloads.length).toBe(1);
  expect(capture.codexConversationPayloads[0]).toEqual({
    message: "Show customer health",
    preferences: { model: "gpt-5.6-terra", reasoningEffort: "max", fastMode: true },
    proMode: false,
    solPlanner: true,
  });
});

test("saved Codex conversations restore the Codex runtime tab", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { codexHistory: true });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Codex business review", exact: true }).click();

  await expect(analysisRuntimeTrigger(page, "Codex")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask Codex about your business" })).toHaveAttribute(
    "placeholder",
    "Ask Codex a follow-up…",
  );
  const composer = page.getByRole("textbox", { name: "Ask Codex about your business" });
  await composer.fill("What time period is that?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => capture.codexConversationPayloads.length).toBe(1);
  const latestAssistant = page.locator("article").last();
  await expect(latestAssistant.getByLabel("Plan")).toBeVisible();
  await expect(latestAssistant.getByLabel("Plan").getByText("3/3", { exact: true })).toBeVisible();
  expect(capture.codexConversationPayloads[0]).toEqual({
    message: "What time period is that?",
    conversationId: "01J00000000000000000000021",
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "max", fastMode: true },
    proMode: false,
    solPlanner: true,
  });
});

test("Codex social follow-ups stay conversational and skip analytical progress", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { codexHistory: true });
  await page.goto("/dash");
  await page.getByRole("button", { name: "Codex business review", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Ask Codex about your business" });
  await composer.fill("nice one");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => capture.codexConversationPayloads.length).toBe(1);
  expect(capture.codexConversationPayloads[0]).toEqual({
    message: "nice one",
    conversationId: "01J00000000000000000000021",
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "max", fastMode: true },
    proMode: false,
    solPlanner: true,
  });
  await expect(page.getByText("Glad that helped.", { exact: true })).toBeVisible();
  const latestAssistant = page.locator("article").last();
  await expect(latestAssistant.getByText("Codex is planning the analysis", { exact: true })).toHaveCount(0);
  await expect(latestAssistant.getByText("Codex evidence grounding", { exact: true })).toHaveCount(0);
});

test("Codex answers the current date from the tenant clock without a data investigation", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { codexHistory: true });
  await page.goto("/dash");
  await page.getByRole("button", { name: "Codex business review", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Ask Codex about your business" });
  await composer.fill("whats todays date");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => capture.codexConversationPayloads.length).toBe(1);
  await expect(page.getByText("Today is Friday, 21 August 2026.", { exact: true })).toBeVisible();
  const latestAssistant = page.locator("article").last();
  await expect(latestAssistant.getByText("Codex is planning the analysis", { exact: true })).toHaveCount(0);
  await expect(latestAssistant.getByText(/Querying/u)).toHaveCount(0);
  expect(capture.codexConversationPayloads[0]).toEqual({
    message: "whats todays date",
    conversationId: "01J00000000000000000000021",
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "max", fastMode: true },
    proMode: false,
    solPlanner: true,
  });
});

test("Codex handles relative calendar follow-ups without entering analytics", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { codexHistory: true });
  await page.goto("/dash");
  await page.getByRole("button", { name: "Codex business review", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Ask Codex about your business" });
  await composer.fill("date tomorrow?");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => capture.codexConversationPayloads.length).toBe(1);
  await expect(page.getByText("Tomorrow is Saturday, 22 August 2026.", { exact: true })).toBeVisible();
  const latestAssistant = page.locator("article").last();
  await expect(latestAssistant.getByText("Codex is planning the analysis", { exact: true })).toHaveCount(0);
  await expect(latestAssistant.getByText(/Querying/u)).toHaveCount(0);
  expect(capture.codexConversationPayloads[0]).toEqual({
    message: "date tomorrow?",
    conversationId: "01J00000000000000000000021",
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "max", fastMode: true },
    proMode: false,
    solPlanner: true,
  });
});

test("Codex tab is accessible in compact dark mode with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openDashboard(page);
  await expect(page.getByRole("textbox", { name: "Ask Codex about your business" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    runningAnimations: document
      .querySelector("main")
      ?.getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running").length ?? 0,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.runningAnimations).toBe(0);
  await expectNoWcagViolations(page, "Codex compact dark");
});

test("Compare launches Albert and Codex concurrently with the exact same prompt and streams both panes", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { v3DelayMs: 650, codexDelayMs: 650 });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await analysisRuntimeTrigger(page, "Codex").click();
  const codexOption = page.getByRole("menuitemradio", { name: /Codex/u });
  await expect(codexOption).toHaveAttribute("aria-checked", "true");
  await expect(codexOption).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const compareOption = page.getByRole("menuitemradio", { name: "Compare", exact: true });
  await expect(compareOption).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(analysisRuntimeTrigger(page, "Compare")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Ask once. Watch both analyse.", level: 2 })).toBeVisible();
  await expect(page.getByText("Independent prompts and tool sets", { exact: true })).toBeVisible();
  const compareSettings = page.getByTestId("model-run-controls-trigger");
  await expect(compareSettings).toHaveAttribute(
    "aria-label",
    "Run settings: GPT 5.6 Luna, Fast mode, max reasoning",
  );
  await compareSettings.click();
  await expect(page.getByRole("radio", { name: "GPT 5.6 Luna" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "GPT 5.6 Terra" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "GPT 5.6 Sol" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Grok 4.6" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Claude Haiku 4.5" })).toHaveCount(0);
  await page.getByRole("radio", { name: "GPT 5.6 Terra" }).click();
  await page.keyboard.press("Escape");
  await expect(compareSettings).toHaveAttribute(
    "aria-label",
    "Run settings: GPT 5.6 Terra, Fast mode, max reasoning",
  );
  const prompt = "Which categories performed best last month?";
  const composer = page.getByRole("textbox", { name: "Ask both Albert and Codex" });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Compare answers", exact: true }).click();

  await expect.poll(() => capture.runtimeRequestStartedAt.v3.length).toBe(1);
  await expect.poll(() => capture.runtimeRequestStartedAt.codex.length).toBe(1);
  expect(Math.abs(
    capture.runtimeRequestStartedAt.v3[0]! - capture.runtimeRequestStartedAt.codex[0]!,
  )).toBeLessThan(150);
  expect(capture.conversationPayloads[0]).toEqual({
    message: prompt,
    preferences: { model: "gpt-5.6-terra", reasoningEffort: "max", fastMode: true },
    specialistAgentId: "general",
    comparisonMode: true,
  });
  expect(capture.codexConversationPayloads[0]).toEqual({
    message: prompt,
    preferences: { model: "gpt-5.6-terra", reasoningEffort: "max", fastMode: true },
    comparisonMode: true,
  });

  const albertPane = page.getByRole("region", { name: "Albert comparison result" });
  const codexPane = page.getByRole("region", { name: "Codex comparison result" });
  await expect(albertPane.getByText(/GPT 5\.6 Terra · Max · Fast/u)).toBeVisible();
  await expect(codexPane.getByText(/GPT 5\.6 Terra · Max · Fast/u)).toBeVisible();
  await expect(albertPane.getByText(/Bikes led net sales in July/u)).toBeVisible();
  await expect(codexPane.getByText(/Bikes led net sales in July/u)).toBeVisible();
  await expect(codexPane.getByLabel("Plan")).toBeVisible();
  await expect(codexPane.getByLabel("Plan").getByText("3/3", { exact: true })).toBeVisible();
  await expect(albertPane.getByText("Complete", { exact: true })).toBeVisible();
  await expect(codexPane.getByText("Complete", { exact: true })).toBeVisible();
  await expect(page.getByText(/Observed answer times/u)).toBeVisible();
  await expect(page.getByText("Same analytical brief", { exact: true })).toBeVisible();
  await expect(page.getByText(/answered .* sooner/u)).toHaveCount(0);
  await expectNoWcagViolations(page, "Compare completed panes");
});

test("Compare cancellation is lane-isolated and Stop both remains available", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { v3DelayMs: 1_500, codexDelayMs: 1_500 });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await selectAnalysisRuntime(page, "Compare");
  await page.getByRole("textbox", { name: "Ask both Albert and Codex" }).fill("Compare customer health");
  await page.getByRole("button", { name: "Compare answers", exact: true }).click();
  await expect.poll(() => capture.runtimeRequestStartedAt.v3.length).toBe(1);
  await expect.poll(() => capture.runtimeRequestStartedAt.codex.length).toBe(1);

  await page.getByRole("button", { name: "Stop Albert", exact: true }).click();
  const albertPane = page.getByRole("region", { name: "Albert comparison result" });
  await expect(albertPane.getByText("Stopped", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Codex", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop both", exact: true }).click();
  const codexPane = page.getByRole("region", { name: "Codex comparison result" });
  await expect(codexPane.getByText("Stopped", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Observed answer times/u)).toHaveCount(0);
});

test("Compare stacks both live panes accessibly on compact dark screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await installAppApiRoutes(page);
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await selectAnalysisRuntime(page, "Compare");
  const albertPane = page.getByRole("region", { name: "Albert comparison result" });
  const codexPane = page.getByRole("region", { name: "Codex comparison result" });
  const [albertBox, codexBox] = await Promise.all([albertPane.boundingBox(), codexPane.boundingBox()]);
  expect(albertBox).not.toBeNull();
  expect(codexBox).not.toBeNull();
  expect(codexBox!.y).toBeGreaterThan(albertBox!.y + albertBox!.height - 2);
  const overflow = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
  await expectNoWcagViolations(page, "Compare compact dark");
});

test("Customers specialist navigation is hidden from bookkeepers", async ({ page }) => {
  await installAppApiRoutes(page, { role: "bookkeeper" });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Customer review", exact: true })).toHaveCount(0);
});

test("the Customer Agent remains usable in the compact dark sidebar with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await installAppApiRoutes(page, { specialistHistory: true });
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Customer review", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Ask the Customer Agent" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    runningAnimations: document
      .querySelector("main")
      ?.getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running").length ?? 0,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.runningAnimations).toBe(0);
  await expectNoWcagViolations(page, "system dark");
});

test("model, Fast, and reasoning controls bind to the governed request and render an ordered trace", async ({
  page,
}) => {
  const capture = await openDashboard(page);
  await openAlbertChat(page);
  const composer = page.getByRole("textbox", { name: "Ask me anything" });
  await composer.focus();

  const settingsTrigger = page.getByTestId("model-run-controls-trigger");
  await expect(settingsTrigger).toBeVisible();
  await expect(settingsTrigger).toBeInViewport();
  await settingsTrigger.click();
  await expect(
    page.getByRole("dialog", { name: "Model and run settings" }),
  ).toBeVisible();
  await expect(page.locator("[data-reasoning-effort]")).toHaveCount(6);
  expect(
    await page
      .locator("[data-reasoning-effort]")
      .evaluateAll((elements) =>
        elements.map((element) =>
          element.getAttribute("data-reasoning-effort"),
        ),
      ),
  ).toEqual(["max", "xhigh", "high", "medium", "low", "none"]);
  await expect(page.locator("[data-model-id]")).toHaveCount(5);
  expect(
    await page
      .locator("[data-model-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-model-id")),
      ),
  ).toEqual([
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "grok-4.6",
    "claude-haiku-4-5-20251001",
  ]);
  await page.getByRole("radio", { name: "GPT 5.6 Terra", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "GPT 5.6 Terra", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  const fastMode = page.getByRole("switch", { name: "Fast mode" });
  if ((await fastMode.getAttribute("aria-checked")) !== "true")
    await fastMode.click();
  await expect(fastMode).toHaveAttribute("aria-checked", "true");
  const reasoningCases = [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "none",
  ] as const;
  for (const [index, reasoningEffort] of reasoningCases.entries()) {
    await page.locator(`[data-reasoning-effort="${reasoningEffort}"]`).click();
    await page.keyboard.press("Escape");
    await expect(settingsTrigger).toBeFocused();
    await expect(settingsTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(settingsTrigger).toHaveAttribute(
      "aria-label",
      new RegExp(`GPT 5\\.6 Terra, Fast mode, ${reasoningEffort} reasoning`, "u"),
    );

    const message =
      index === reasoningCases.length - 1
        ? "Which categories performed best last month?"
        : `Verify the ${reasoningEffort} reasoning request binding.`;
    await composer.fill(message);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() => capture.conversationPayloads.length)
      .toBe(index + 1);
    expect(capture.conversationPayloads[index]).toMatchObject({
      message,
      preferences: {
        model: "gpt-5.6-terra",
        fastMode: true,
        reasoningEffort,
      },
    });
    await expect(page.getByText(/Bikes led net sales in July/u)).toHaveCount(
      index + 1,
    );

    if (index < reasoningCases.length - 1) {
      await settingsTrigger.click();
      await expect(
        page.getByRole("dialog", { name: "Model and run settings" }),
      ).toBeVisible();
      await expect(
        page.locator(`[data-reasoning-effort="${reasoningEffort}"]`),
      ).toBeFocused();
    }
  }

  await expect(
    page.getByText(/Bikes led net sales in July/u).last(),
  ).toBeVisible();
  const trailTrigger = page
    .getByRole("button", {
      name: /Worked.*Sources: Lightspeed Retail R-Series sales/u,
    })
    .last();
  await expect(trailTrigger).toBeVisible();
  await trailTrigger.click();
  await expect(trailTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText("Planning the governed analysis").last(),
  ).toBeVisible();
  await expect(page.getByText("Matched 1 governed Topic").last()).toBeVisible();
  await page
    .getByRole("button", { name: "Detailed mode", exact: true })
    .click();
  await expect(page.getByRole("table").last()).toContainText("Workshop");
  await expect(page.getByLabel("Chart").last()).toBeVisible();
  await expect(page.getByText("golden_fixture_match")).toHaveCount(0);
  await expect(page.getByText("Checked", { exact: true }).last()).toBeVisible();
});

test("Grok 4.6 selector binds official model id and Grok reasoning levels", async ({
  page,
}) => {
  const capture = await openDashboard(page);
  await openAlbertChat(page);
  const composer = page.getByRole("textbox", { name: "Ask me anything" });
  const settingsTrigger = page.getByTestId("model-run-controls-trigger");
  await settingsTrigger.click();
  await expect(
    page.getByRole("dialog", { name: "Model and run settings" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Grok 4.6", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Grok 4.6", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Fast mode" })).toHaveCount(1);
  const grokFast = page.getByRole("switch", { name: "Fast mode" });
  if ((await grokFast.getAttribute("aria-checked")) === "true") await grokFast.click();
  await expect(grokFast).toHaveAttribute("aria-checked", "false");
  await grokFast.click();
  await expect(grokFast).toHaveAttribute("aria-checked", "true");
  expect(
    await page
      .locator("[data-reasoning-effort]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-reasoning-effort")),
      ),
  ).toEqual(["xhigh", "high", "medium", "low"]);
  await page.locator('[data-reasoning-effort="xhigh"]').click();
  await page.keyboard.press("Escape");
  await expect(settingsTrigger).toHaveAttribute(
    "aria-label",
    /Grok 4\.6, Fast mode, xhigh reasoning/u,
  );
  await composer.fill("Which categories performed best last month?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => capture.conversationPayloads.length).toBe(1);
  expect(capture.conversationPayloads[0]).toMatchObject({
    message: "Which categories performed best last month?",
    preferences: {
      model: "grok-4.6",
      fastMode: true,
      reasoningEffort: "xhigh",
    },
  });
});

test("Claude Haiku 4.5 selector binds manual reasoning levels without Fast mode", async ({
  page,
}) => {
  const capture = await openDashboard(page);
  await openAlbertChat(page);
  const composer = page.getByRole("textbox", { name: "Ask me anything" });
  const settingsTrigger = page.getByTestId("model-run-controls-trigger");
  await settingsTrigger.click();
  await page.getByRole("radio", { name: "Claude Haiku 4.5", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Claude Haiku 4.5", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Fast mode" })).toHaveCount(0);
  await expect(
    page.getByText(/Data is processed globally by Anthropic.*Haiku starts at Low.*High and Max can take minutes/u),
  ).toBeVisible();
  await expect(page.locator('[data-reasoning-effort="low"]')).toHaveAttribute("aria-pressed", "true");
  expect(
    await page
      .locator("[data-reasoning-effort]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-reasoning-effort")),
      ),
  ).toEqual(["max", "xhigh", "high", "medium", "low", "none"]);
  await page.locator('[data-reasoning-effort="high"]').click();
  await page.keyboard.press("Escape");
  await expect(settingsTrigger).toHaveAttribute(
    "aria-label",
    /Claude Haiku 4\.5, Standard speed, high reasoning/u,
  );
  await composer.fill("Which categories performed best last month?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => capture.conversationPayloads.length).toBe(1);
  expect(capture.conversationPayloads[0]).toMatchObject({
    message: "Which categories performed best last month?",
    preferences: {
      model: "claude-haiku-4-5-20251001",
      fastMode: false,
      reasoningEffort: "high",
    },
  });
});

test("keyboard focus follows dash shortcuts, popovers, drawers, lineage, and destructive confirmation", async ({
  page,
}) => {
  await openDashboard(page);
  await openAlbertChat(page);

  await page.keyboard.press("Control+KeyK");
  await expect(page.getByRole("textbox", { name: "Search" })).toBeFocused();

  await page.keyboard.press("Alt+KeyN");
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();

  const accountTrigger = page
    .getByRole("button", { name: /Albert Bike Store/u })
    .last();
  await accountTrigger.click();
  await expect(
    page.getByRole("button", { name: "System theme" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(accountTrigger).toBeFocused();

  const composer = page.getByRole("textbox", { name: "Ask Codex about your business" });
  await composer.focus();
  await expect(
    page.getByRole("button", { name: "New Analysis" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Conversations" }),
  ).toBeVisible();

  await composer.fill("Show category performance");
  await page.getByRole("button", { name: "Send message" }).click();
  const trailTrigger = page.getByRole("button", { name: /Worked.*Sources:/u });
  await trailTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(trailTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(trailTrigger).toBeFocused();

  await accountTrigger.click();
  await page.getByRole("button", { name: "Connections" }).click();
  const xeroConnections = page.getByLabel("Xero connections");
  const manageTrigger = xeroConnections.getByRole("button", { name: "Manage" });
  await manageTrigger.click();
  await expect(
    page.getByRole("button", { name: "Close connection settings" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(manageTrigger).toBeFocused();
});

test("Connections supports progressive readiness and account selection", async ({
  page,
}) => {
  const capture = await openDashboard(page);
  await openConnections(page);
  await expect(
    page.getByRole("heading", { name: "Connections", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: /sync progress/u }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Xero" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /Review/u })).toHaveCount(0);

  await page.getByRole("button", { name: /Albert Workshop Pty Ltd/u }).click();
  await expect.poll(() => capture.oauthSelectionPayloads.length).toBe(1);
  expect(capture.oauthSelectionPayloads[0]).toEqual({
    oauthSessionId: "01J0000000000000000000OS1",
    externalAccountId: "xero-account-2",
  });
});

test("OAuth callback cancellation, invalid response, and unknown provider fail safely without vendor secrets", async ({
  page,
}) => {
  await installAppApiRoutes(page);

  await page.goto("/api/oauth/xero/callback?error=access_denied");
  await expect(
    page.getByText("Xero authorization was cancelled. Nothing was changed."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/dash\?view=Connections$/u);

  await page.goto("/api/oauth/deputy/callback");
  await expect(page.getByRole("alert")).toContainText(
    "Deputy returned an invalid or expired authorization response",
  );

  await page.goto("/api/oauth/not-a-provider/callback");
  await expect(page.getByRole("alert")).toContainText(
    "That connection provider is not supported.",
  );
});

test("Connections launches the exact same-origin OAuth start path", async ({
  page,
}) => {
  await openDashboard(page);
  let launch:
    | Readonly<{ method: string; url: string; initiatorOrigin: string }>
    | undefined;
  await page.route(/\/api\/oauth\/fivetran-lightspeed\/start$/u, async (route) => {
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
  await page
    .getByLabel("Lightspeed connections")
    .getByRole("button", { name: "Connect" })
    .click();
  await expect(
    page.getByText("Provider handoff boundary reached."),
  ).toBeVisible();
  expect(launch).toEqual({
    method: "GET",
    url: "https://127.0.0.1:3101/api/oauth/fivetran-lightspeed/start",
    initiatorOrigin: "https://127.0.0.1:3101",
  });
});

test("mobile layout has no page overflow and reduced motion disables analytical animations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDashboard(page);
  await openAlbertChat(page);

  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  const composer = page.getByRole("textbox", { name: "Ask me anything" });
  await composer.fill("Show category performance");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Bikes led net sales in July/u)).toBeVisible();

  const runningAnimations = await page
    .locator("main")
    .evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getTiming().iterations !== Infinity,
          ).length,
    );
  expect(runningAnimations).toBe(0);

  await openConnections(page);
  await expect(
    page.getByRole("heading", { name: "Connections", level: 1 }),
  ).toBeVisible();
  const layout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    sidebarWidth: Math.round(
      document.querySelector("aside")?.getBoundingClientRect().width ?? 0,
    ),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.sidebarWidth).toBe(45);
});

test("Omni harness renders tasks, research steps, query cards and the answer", async ({ page }) => {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");
  await selectAnalysisRuntime(page, "Omni");
  await expect(analysisRuntimeTrigger(page, "Omni")).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Ask Omni about your business" });
  await expect(composer).toHaveAttribute(
    "placeholder",
    "Ask anything about your connected data…",
  );
  await composer.fill("Show me revenue by week for the last 12 complete weeks.");
  await composer.press("Enter");

  // The Omni task checklist arrives first and settles fully completed.
  await expect(page.getByText("Tasks (3 of 3)")).toBeVisible();
  await expect(page.getByText("Find the revenue fields")).toBeVisible();

  // Research group with the semantic model search card and its YAML body.
  await expect(page.getByRole("button", { name: /Research · 1 step/u })).toBeVisible();
  const searchCard = page.getByRole("button", {
    name: /Search model.*2 fields found matching/u,
  });
  await expect(searchCard).toBeVisible();
  await searchCard.click();
  await expect(page.getByText('Search: "revenue"')).toBeVisible();
  await expect(page.getByText(/view_name: sales_analytics/u)).toBeVisible();

  // The named query card with its topic, row count and result table.
  await expect(page.getByRole("button", { name: /Query.*Weekly revenue.*From Sales analytics · 2 rows/u })).toBeVisible();
  await expect(page.getByRole("cell", { name: "AUD 8,379.02" })).toBeVisible();

  // Interim narration and the final verified answer with a follow-up chip.
  await expect(page.getByText("I found the governed revenue measure. Querying weekly revenue now.")).toBeVisible();
  await expect(page.getByText(/Revenue held steady across the last 12 complete weeks/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "How does this compare to last year?" })).toBeVisible();

  // Markdown structure in the answer renders styled: heading, table, and
  // figure columns right-aligned by the numeric-column pass.
  await expect(page.getByRole("heading", { name: "Weekly detail", level: 3 })).toBeVisible();
  const answerFigureCell = page.getByRole("cell", { name: "+3.2%" });
  await expect(answerFigureCell).toBeVisible();
  await expect(answerFigureCell).toHaveAttribute("data-numeric", "true");
  await expect(page.getByRole("cell", { name: "27 July", exact: true })).toHaveAttribute("data-numeric", "false");

  // Statement-style rows: a bolded total line carries the accountant's rule,
  // and parenthesised negatives still count as figure cells.
  const grossProfitCell = page.getByRole("cell", { name: "Gross profit" });
  await expect(grossProfitCell).toBeVisible();
  const ruledRow = page.locator("tr", { has: grossProfitCell });
  await expect(ruledRow).toHaveAttribute("data-statement-row", "true");
  await expect(ruledRow.locator("td").first()).toHaveCSS("border-top-width", "2px");
  await expect(page.locator("tr", { has: page.getByRole("cell", { name: "Sales revenue" }) })).toHaveAttribute("data-statement-row", "false");
  await expect(page.getByRole("cell", { name: "($16,908.12)" })).toHaveAttribute("data-numeric", "true");

  // Statement detail lines indented with &nbsp; render as real indentation,
  // never as literal entity text.
  const wagesCell = page.getByRole("cell", { name: "Wages and salaries" });
  await expect(wagesCell).toBeVisible();
  await expect(wagesCell).not.toContainText("&nbsp;");
  expect(await wagesCell.evaluate((cell) => cell.textContent?.startsWith("  "))).toBe(true);

  // The request went to the Omni endpoint with model preferences attached.
  expect(capture.omniConversationPayloads.length).toBe(1);
  const payload = capture.omniConversationPayloads[0] as Record<string, unknown>;
  expect(payload.message).toBe("Show me revenue by week for the last 12 complete weeks.");
  expect((payload.preferences as Record<string, unknown>).model).toBe("gpt-5.6-luna");

  // A full-turn visual artifact for review, kept outside version control.
  await page.getByText("The lift came from stronger weekend trade.").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".playwright/omni-harness-turn.png", fullPage: true });
});
