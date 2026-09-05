import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  installAppApiRoutes,
  installSupabaseBrowserAuthRoutes,
} from "./support/app-fixtures";
import { selectDiscoverCards } from "../../services/discover/src/library";

async function openDashboard(page: Parameters<typeof installAppApiRoutes>[0]) {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");
  await expect(
    page.getByRole("heading", { name: "New Analysis", level: 1 }),
  ).toBeVisible();
  return capture;
}

type AnalysisRuntime = "Albert" | "Codex" | "Omni" | "Compare";

/** `?runtime=` values the dash accepts. */
const RUNTIME_PARAMS: Record<AnalysisRuntime, string> = {
  Albert: "albert",
  Codex: "codex",
  Omni: "omni",
  Compare: "compare",
};

/** The `data-chat-runtime` stamp on the chat workspace (Albert is the v3 engine). */
const RUNTIME_STAMPS: Record<Exclude<AnalysisRuntime, "Compare">, string> = {
  Albert: "v3",
  Codex: "codex",
  Omni: "omni",
};

/** The chat workspace stamps its runtime; Compare replaces the workspace with its own header. */
async function expectAnalysisRuntime(
  page: Parameters<typeof installAppApiRoutes>[0],
  runtime: AnalysisRuntime,
) {
  if (runtime === "Compare") {
    // The Compare title is hidden on compact screens; the shared composer is not.
    await expect(page.getByRole("textbox", { name: "Ask both Albert and Codex" })).toBeVisible();
    return;
  }
  await expect(page.locator(`[data-chat-runtime="${RUNTIME_STAMPS[runtime]}"]`)).toBeVisible();
}

/**
 * The chat offers only Omni (ADR 0130). Albert, Codex and Compare stay
 * reachable for verification through the internal `?runtime=` entry.
 */
async function selectAnalysisRuntime(
  page: Parameters<typeof installAppApiRoutes>[0],
  runtime: AnalysisRuntime,
) {
  const url = new URL(page.url());
  if (runtime === "Omni") url.searchParams.delete("runtime");
  else url.searchParams.set("runtime", RUNTIME_PARAMS[runtime]);
  await page.goto(`${url.pathname}${url.search}`);
  if (runtime !== "Compare") {
    await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  }
  await expectAnalysisRuntime(page, runtime);
}

async function openAlbertChat(page: Parameters<typeof installAppApiRoutes>[0]) {
  await selectAnalysisRuntime(page, "Albert");
  await expect(page.getByRole("textbox", { name: "Ask me anything" })).toBeVisible();
}

async function openCodexChat(page: Parameters<typeof installAppApiRoutes>[0]) {
  await selectAnalysisRuntime(page, "Codex");
  await expect(page.getByRole("textbox", { name: "Ask Codex about your business" })).toBeVisible();
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
  // Bare rows: no heading, verdict or card around them.
  await expect(recommended.getByRole("heading")).toHaveCount(0);
  await expect(recommended.getByText("You've looked at sales and customers recently.")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recent analysis" })).toHaveCount(0);
  await expect(recommended.getByRole("button", {
    name: "Ask: Which products dragged Wednesday's sales last week?",
  })).toBeVisible();
  await expect(recommended.getByRole("button", {
    name: "Ask: What is dragging parts margin: mix, discounting, or cost?",
  })).toBeVisible();
  await expect(recommended.getByText("Did last week's takings reach the bank", { exact: false })).toBeVisible();
  // One sentence per row, with the logo of the tool it reads at the left.
  const cashRow = recommended.getByRole("button", { name: "Ask: Did last week's takings reach the bank, and what is still outstanding?" });
  await expect(cashRow.locator("img")).toHaveAttribute("src", /logos\/xero\.svg/u);
  await expect(recommended.getByText("You reviewed sales, but not whether that cash actually landed.")).toHaveCount(0);

  await recommended.getByRole("button", {
    name: "Ask: Which products dragged Wednesday's sales last week?",
  }).click();
  await expect(page.getByRole("region", { name: "What to look at next" })).toHaveCount(0);
  // The recommendation is asked on whichever harness the chat runs (Omni by default).
  const sentPayloads = () => [
    ...capture.omniConversationPayloads,
    ...capture.conversationPayloads,
    ...capture.codexConversationPayloads,
  ];
  await expect.poll(() => sentPayloads().length).toBeGreaterThan(0);
  const sent = sentPayloads()[0] as {
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
  // The Dashboard tab is a visible destination since the natural-language
  // builder landed (ADR 0129); Test chart stays internal.
  await expect(page.getByRole("button", { name: "Dashboards", exact: true })).toBeVisible();
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
  await expect(page.getByRole("textbox", { name: "Ask Omni about your business" })).toHaveAttribute(
    "placeholder",
    "Ask anything about your connected data…",
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

test("Omni is the default harness and Albert remains reachable", async ({ page }) => {
  const capture = await openDashboard(page);
  await expectAnalysisRuntime(page, "Omni");
  await expect(page.getByRole("button", { name: /Analysis runtime/u })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Discover" })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("heading", { name: "Ask about your business", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Suggested investigations" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Ask Omni about your business" })).toHaveAttribute(
    "placeholder",
    "Ask anything about your connected data…",
  );
  const omniSettings = page.getByTestId("model-run-controls-trigger");
  await expect(omniSettings).toHaveAttribute(
    "aria-label",
    "Run settings: Claude Haiku 4.5, Standard speed, max reasoning, Super agent off, Swarm off",
  );
  await omniSettings.click();
  await expect(page.getByRole("switch", { name: "Super agent" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Swarm" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("radio", { name: "Claude Haiku 4.5" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "GPT 5.6 Luna" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "GPT 5.6 Terra" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "GPT 5.6 Sol" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Claude Sonnet 5" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Grok 4.6" })).toHaveCount(0);
  await expect(page.locator('[data-reasoning-effort="max"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  const prompt = "Show me revenue by week for the last 12 complete weeks.";
  await page.getByRole("textbox", { name: "Ask Omni about your business" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => capture.omniConversationPayloads.length).toBe(1);
  await expect(page.getByText("Tasks (3 of 3)")).toBeVisible();
  await expect(page.getByText(/Revenue held steady across the last 12 complete weeks/u)).toBeVisible();
  expect(capture.omniConversationPayloads[0]).toEqual({
    message: prompt,
    preferences: { model: "claude-haiku-4-5-20251001", reasoningEffort: "max", fastMode: false },
  });
  expect(capture.codexConversationPayloads).toHaveLength(0);
  expect(capture.conversationPayloads).toHaveLength(0);

  await selectAnalysisRuntime(page, "Albert");
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
  await openCodexChat(page);

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
  await openCodexChat(page);
  const settings = page.getByTestId("model-run-controls-trigger");
  await settings.click();
  const proReasoning = page.getByRole("switch", { name: "Pro reasoning" });
  await proReasoning.click();
  await expect(proReasoning).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  const prompt = "We need to pay out 1500AUD per month to owners. What can we do to make this in extra GP per month.";
  await page.getByRole("textbox", { name: "Ask Codex about your business" }).fill(prompt);
  await settings.click();
  await expect(page.getByRole("switch", { name: "Swarm" })).toBeVisible();
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
  await openCodexChat(page);
  const prompt = "How can we improve profitability?";
  await page.getByRole("textbox", { name: "Ask Codex about your business" }).fill(prompt);
  await page.getByTestId("model-run-controls-trigger").click();
  await expect(page.getByRole("switch", { name: "Super agent" })).toBeVisible();
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
  await openCodexChat(page);
  const settings = page.getByTestId("model-run-controls-trigger");
  await settings.click();
  await page.getByRole("radio", { name: "GPT 5.6 Terra" }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveAttribute(
    "aria-label",
    "Run settings: GPT 5.6 Terra, Fast mode, max reasoning, Super agent off, Swarm off, Pro reasoning off, Sol planner on",
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

  await expectAnalysisRuntime(page, "Codex");
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
  await openCodexChat(page);
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
  await selectAnalysisRuntime(page, "Compare");

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
  await page.getByRole("radio", { name: "GPT 5.6 Luna", exact: true }).click();
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

  await openCodexChat(page);
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
  await expectAnalysisRuntime(page, "Omni");

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

  // The named query card starts collapsed with its name, topic, row count
  // and the source tool's logo in the top-right corner; expanding reveals
  // the evidence table.
  const queryCardHeader = page.getByRole("button", { name: /Query.*Weekly revenue.*From Sales analytics · 2 rows/u });
  await expect(queryCardHeader).toBeVisible();
  await expect(queryCardHeader).toHaveAttribute("aria-expanded", "false");
  const connectorLogo = page.getByTitle("Data from Lightspeed");
  await expect(connectorLogo).toBeVisible();
  await expect(connectorLogo.getByAltText("Lightspeed")).toBeVisible();
  await expect(page.getByRole("cell", { name: "AUD 8,379.02" })).not.toBeVisible();
  await queryCardHeader.click();
  await expect(page.getByRole("cell", { name: "AUD 8,379.02" })).toBeVisible();

  // Interim narration and the final verified answer with a follow-up chip.
  await expect(page.getByText("I found the governed revenue measure. Querying weekly revenue now.")).toBeVisible();
  await expect(page.getByText(/Revenue held steady across the last 12 complete weeks/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "How does this compare to last year?" })).toBeVisible();

  // The Codex-style work header settles from "Working for" into "Worked for"
  // once the answer lands, above the whole trail under its full-width rule.
  await expect(page.getByText(/^Worked for \d+[smh]/u)).toBeVisible();
  await expect(page.getByText(/^Working for /u)).not.toBeVisible();

  // Markdown structure in the answer renders styled: heading, table, and
  // figure columns right-aligned by the numeric-column pass.
  await expect(page.getByRole("heading", { name: "Weekly detail", level: 3 })).toBeVisible();
  const answerFigureCell = page.getByRole("cell", { name: "+3.2%" });
  await expect(answerFigureCell).toBeVisible();
  await expect(answerFigureCell).toHaveAttribute("data-numeric", "true");
  await expect(page.getByRole("cell", { name: "27 July", exact: true })).toHaveAttribute("data-numeric", "false");

  // Statement-style rows: a bolded total line carries the accountant's rule,
  // and parenthesised negatives still count as figure cells.
  const statementTable = page.getByRole("table").filter({
    has: page.getByRole("columnheader", { name: "P&L line", exact: true }),
  });
  const grossProfitCell = statementTable.getByRole("cell", { name: "Gross profit" });
  await expect(grossProfitCell).toBeVisible();
  const ruledRow = statementTable.getByRole("row", { name: /^Gross profit\b/u });
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
  expect((payload.preferences as Record<string, unknown>).model).toBe("claude-haiku-4-5-20251001");
  expect((payload.preferences as Record<string, unknown>).reasoningEffort).toBe("max");

  // A full-turn visual artifact for review, kept outside version control.
  await page.getByText("The lift came from stronger weekend trade.").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".playwright/omni-harness-turn.png", fullPage: true });
});

test("Dashboard mode builds a live dashboard from the chat", async ({ page }) => {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");

  // The composer toggle enters dashboard mode: the chat stays on the left and
  // the dashboard preview card opens on the right.
  await page.getByRole("button", { name: "Dashboard mode" }).click();
  const panel = page.getByRole("complementary", { name: "Dashboard preview" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Describe what you want to watch" })).toBeVisible();

  // The composer is the build input; the ask streams as a dashboard turn.
  const composer = page.getByRole("textbox", { name: "Describe the dashboard you want" });
  await composer.fill("I need a dashboard that shows top level metrics");
  await composer.press("Enter");

  // The chat keeps the owner's own words as the visible question (the
  // sidebar titles the conversation with the same words), and the working
  // (task checklist + governed queries) streams into the trail.
  await expect(
    page.locator("p", { hasText: "I need a dashboard that shows top level metrics" }),
  ).toBeVisible();
  await expect(page.getByText("Choose the standing questions")).toBeVisible();

  // The applied dashboard forms in the panel: live badge, the name on the
  // document, KPI value with its like-for-like delta, the chart tile, and
  // the detail table.
  await expect(panel.getByText("Live")).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Dashboard name" })).toHaveValue("Ashburton at a glance");
  // Role queries skip the aria-hidden crossfade overlay, so these target the
  // real workspace tiles.
  const revenueTile = panel.getByRole("region", { name: "Revenue", exact: true });
  await expect(revenueTile.getByText("$41,230.55")).toBeVisible();
  await expect(revenueTile.getByText("12.1%")).toBeVisible();
  await expect(revenueTile.getByText("vs previous 30 days")).toBeVisible();
  await expect(panel.getByRole("region", { name: "Revenue by week" })).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "Revenue by week" }).locator("svg").first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("region", { name: "Top products by revenue" })).toBeVisible();
  await expect(panel.getByRole("cell", { name: "Gravel bike hire" })).toBeVisible();

  // The panel hosts the real workspace: the dashboard is renameable inline,
  // refreshable, and its tiles carry the move/resize affordances.
  const nameInput = panel.getByRole("textbox", { name: "Dashboard name" });
  await expect(nameInput).toHaveValue("Ashburton at a glance");
  await nameInput.fill("Ops cockpit");
  await nameInput.press("Enter");
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "rename"
  )).length).toBe(1);
  const renameCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "rename"
  )) as { body?: { title?: string } } | undefined;
  expect(renameCall?.body?.title).toBe("Ops cockpit");
  // Every document call is addressed to the dashboard the build landed on.
  expect((renameCall?.body as { dashboardId?: string } | undefined)?.dashboardId).toBe("01J00000000000000000DBRD01");
  await expect(panel.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  await expect(
    panel.getByRole("button", { name: /Move or resize Revenue\b/u }).first(),
  ).toBeVisible();

  // Visual acceptance of the split view: chat card left, dashboard card right.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: ".playwright/dashboard-mode-split.png" });

  // The two cards share the exact footprint the single content card has in
  // normal chat mode (an 8px inset in the classic view): no nested inset.
  const edges = await page.evaluate(() => {
    const chat = document.querySelector("section[aria-labelledby='dash-title'] > div > div");
    const aside = document.getElementById("analysis-takeaways");
    if (!chat || !aside) return null;
    const c = chat.getBoundingClientRect();
    const a = aside.getBoundingClientRect();
    return {
      chatTop: Math.round(c.top), chatBottom: Math.round(window.innerHeight - c.bottom),
      asideTop: Math.round(a.top), asideBottom: Math.round(window.innerHeight - a.bottom),
      asideRight: Math.round(window.innerWidth - a.right), asideWidth: Math.round(a.width),
    };
  });
  expect(edges).not.toBeNull();
  expect(edges!.chatTop).toBe(8);
  expect(edges!.chatBottom).toBe(8);
  expect(edges!.asideTop).toBe(8);
  expect(edges!.asideBottom).toBe(8);
  expect(edges!.asideRight).toBe(8);

  // The split is draggable: dragging the separator left widens the dashboard
  // card, the keyboard nudges it, and a double-click restores the default.
  const separator = page.getByRole("separator", { name: /Resize the dashboard panel/u });
  const separatorBox = await separator.boundingBox();
  expect(separatorBox).not.toBeNull();
  const grabX = separatorBox!.x + separatorBox!.width / 2;
  const grabY = separatorBox!.y + separatorBox!.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX - 120, grabY, { steps: 6 });
  await page.mouse.up();
  // The panel width transitions once the drag releases; let it settle.
  await page.waitForTimeout(900);
  const widened = await panel.evaluate((node) => Math.round(node.getBoundingClientRect().width));
  expect(widened).toBeGreaterThanOrEqual(edges!.asideWidth + 100);
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  const nudged = await panel.evaluate((node) => Math.round(node.getBoundingClientRect().width));
  expect(nudged).toBe(widened - 16);
  await separator.dblclick();
  await page.waitForTimeout(800);
  const reset = await panel.evaluate((node) => Math.round(node.getBoundingClientRect().width));
  expect(Math.abs(reset - edges!.asideWidth)).toBeLessThanOrEqual(2);

  // A narrow chat card keeps the composer on one row: the empty field never
  // grows from its placeholder and the controls do not wrap under it.
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.waitForTimeout(900);
  const composerMetrics = await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Ask for changes to your dashboard'], textarea[aria-label='Describe the dashboard you want']");
    const bar = textarea?.closest("form");
    if (!textarea || !bar) return null;
    const send = bar.querySelector("button[aria-label='Send message']");
    return {
      textareaHeight: Math.round(textarea.getBoundingClientRect().height),
      sendOnSameRow: send ? Math.abs(send.getBoundingClientRect().top - textarea.getBoundingClientRect().top) < 24 : false,
    };
  });
  expect(composerMetrics).not.toBeNull();
  expect(composerMetrics!.textareaHeight).toBeLessThanOrEqual(30);
  expect(composerMetrics!.sendOnSameRow).toBe(true);
  await page.screenshot({ path: ".playwright/dashboard-mode-narrow.png" });
  await page.setViewportSize({ width: 1600, height: 1000 });

  // The build ran on the Omni harness in dashboard-architect mode with the
  // server-composed brief carrying the owner's words.
  const briefCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as Record<string, unknown>).endpoint === "build"
  )) as Record<string, unknown> | undefined;
  expect((briefCall?.body as Record<string, unknown>).instruction)
    .toBe("I need a dashboard that shows top level metrics");
  const buildPayload = capture.omniConversationPayloads.find((payload) => (
    (payload as Record<string, unknown>).dashboardBuild === true
  )) as Record<string, unknown> | undefined;
  expect(buildPayload).toBeTruthy();
  expect(String(buildPayload?.message)).toContain("top level metrics");
  expect((buildPayload?.preferences as Record<string, unknown>).fastMode).toBe(false);
  const applyCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as Record<string, unknown>).endpoint === "apply"
  )) as Record<string, unknown> | undefined;
  expect((applyCall?.body as Record<string, unknown>).conversationId).toBe("01J00000000000000000DBCV01");
  expect((applyCall?.body as Record<string, unknown>).turnId).toBe("01J00000000000000000DBTN01");

  // The apply named the dashboard it landed on.
  expect((applyCall?.body as Record<string, unknown>).dashboardId).toBe("01J00000000000000000DBRD01");

  // The Dashboards tab lists the built dashboard; opening it shows the same
  // applied document as governed tiles, with the chart tile actually drawn
  // inside its box (the axis title only exists once Vega has painted; a bare
  // `svg` locator would match header icons).
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
  const dashboardRow = page.getByRole("list", { name: "Your dashboards" }).getByRole("button", { name: /^Ops cockpit/u });
  await expect(dashboardRow).toBeVisible();
  await expect(dashboardRow).toContainText("5 elements");
  await dashboardRow.click();
  await expect(page.getByRole("region", { name: "Revenue", exact: true }).getByText("$41,230.55")).toBeVisible();
  await expect(page.getByRole("region", { name: "Refunds", exact: true }).getByText("26.7%")).toBeVisible();
  await expect(page.getByRole("region", { name: "Revenue by week" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Revenue by week" }).getByText("Gross takings"),
  ).toBeVisible({ timeout: 20_000 });

  await page.waitForTimeout(500);
  // The composed pivot renders as a pivot: a frozen, shaded metric column
  // with the periods across the top and the figures right-aligned.
  const pivot = page.getByRole("region", { name: "Weekly scorecard", exact: true });
  await expect(pivot).toBeVisible();
  const pivotTable = pivot.locator("table[data-pivot='true']");
  await expect(pivotTable).toBeVisible();
  await expect(pivotTable.locator("thead")).toContainText("Period");
  await expect(pivotTable.locator("tbody tr").first().locator("th").first()).toHaveText("Sales");
  await expect(pivotTable.locator("tbody tr").nth(2).locator("td").nth(2)).toHaveText("246");
  const pivotMetrics = await pivotTable.locator("tbody tr").first().locator("th").first().evaluate((cell) => {
    const style = getComputedStyle(cell);
    return { position: style.position, weight: Number(style.fontWeight) };
  });
  expect(pivotMetrics.position).toBe("sticky");
  expect(pivotMetrics.weight).toBeGreaterThanOrEqual(400);
  const valueCellAlign = await pivotTable.locator("tbody tr").first().locator("td").first()
    .evaluate((cell) => getComputedStyle(cell).textAlign);
  expect(valueCellAlign).toBe("right");

  await page.screenshot({ path: ".playwright/dashboard-build.png", fullPage: true });
});

test("Dashboards lists every dashboard, renames and deletes from the row menu, and starts a new one blank", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { dashboardApplied: true });
  await page.goto("/dash");

  // The tab is the list: one heading, one line, one button, quiet rows.
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
  const list = page.getByRole("list", { name: "Your dashboards" });
  const row = list.getByRole("button", { name: /^Ashburton at a glance/u });
  await expect(row).toContainText("5 elements");
  await page.screenshot({ path: ".playwright/dashboards-list.png" });

  // Rename from the row's More menu, inline.
  await list.getByRole("button", { name: "More options for Ashburton at a glance" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("textbox", { name: "Dashboard name" });
  await rename.fill("Shop floor");
  await rename.press("Enter");
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "rename"
  )).length).toBe(1);
  const renameCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "rename"
  )) as { body?: { title?: string; dashboardId?: string } } | undefined;
  expect(renameCall?.body?.title).toBe("Shop floor");
  expect(renameCall?.body?.dashboardId).toBe("01J00000000000000000DBRD01");

  // Open a dashboard from the list and come back.
  await list.getByRole("button", { name: /^(Shop floor|Ashburton at a glance)/u }).click();
  await expect(page.getByRole("region", { name: "Revenue", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dashboards" }).nth(1).click();
  await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();

  // "New dashboard" creates a blank document and opens dashboard mode on it:
  // the chat builds it in natural language, the right card waits for the ask.
  await page.getByRole("button", { name: "New dashboard" }).click();
  await expect.poll(() => capture.dashboardBuildPayloads.some((entry) => (
    (entry as { endpoint?: string }).endpoint === "create"
  ))).toBe(true);
  const panel = page.getByRole("complementary", { name: "Dashboard preview" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Describe what you want to watch" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Describe the dashboard you want" });
  await expect(composer).toBeFocused();
  await composer.fill("Cash and customers for the last quarter");
  await composer.press("Enter");
  // The brief names the new dashboard, so the build lands on it.
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "build"
  )).length).toBe(1);
  const briefCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "build"
  )) as { body?: { dashboardId?: string } } | undefined;
  expect(briefCall?.body?.dashboardId).toBe("01J00000000000000000DBRD02");

  // Delete from the row menu, with a confirmation, straight from the list.
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await list.getByRole("button", { name: /More options for/u }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => capture.dashboardBuildPayloads.some((entry) => (
    (entry as { endpoint?: string }).endpoint === "delete"
  ))).toBe(true);
});

test("Element sort and filters are query overrides that re-run the governed query", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { dashboardApplied: true });
  await page.goto("/dash");
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await page.getByRole("list", { name: "Your dashboards" }).getByRole("button", { name: /^Ashburton at a glance/u }).click();
  const products = page.getByRole("region", { name: "Top products by revenue" });
  await expect(products).toBeVisible();

  // Sigma's column menu: the caret on a header sorts the column.
  await products.getByRole("button", { name: "Column options for Gross takings" }).click();
  await page.getByRole("menuitem", { name: "Sort ascending" }).click();
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  )).length).toBe(1);
  const sortCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  )) as { tileId?: string; body?: { queryOverrides?: unknown; dashboardId?: string } } | undefined;
  expect(sortCall?.tileId).toBe("01J00000000000000000DBT401");
  expect(sortCall?.body?.queryOverrides).toEqual({ order: [{ column: "sales_analytics_gross_takings", direction: "asc" }] });
  expect(sortCall?.body?.dashboardId).toBe("01J00000000000000000DBRD01");
  // The rows re-sort on screen at once, and the governed query re-runs.
  await expect(products.locator("tbody tr").first().locator("td").first()).toHaveText("Helmets");
  await expect.poll(() => capture.dashboardBuildPayloads.some((entry) => (
    (entry as { endpoint?: string; body?: { tileIds?: string[]; force?: boolean } }).endpoint === "refresh"
    && (entry as { body?: { tileIds?: string[] } }).body?.tileIds?.[0] === "01J00000000000000000DBT401"
  ))).toBe(true);

  // Filters: a list filter on a text column, built from the values on screen.
  await products.getByRole("button", { name: "Filters for Top products by revenue" }).click();
  await page.getByRole("button", { name: "Add filter…" }).click();
  await page.getByRole("dialog", { name: "Filters for Top products by revenue" }).getByRole("combobox", { name: "Column", exact: true }).selectOption("sales_analytics_product");
  await page.getByRole("checkbox", { name: "Gravel bike hire" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  )).length).toBe(2);
  const filterCall = capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  ))[1] as { body?: { queryOverrides?: { filters?: unknown; order?: unknown } } } | undefined;
  expect(filterCall?.body?.queryOverrides?.filters).toEqual([
    { column: "sales_analytics_product", operator: "equals", values: ["Gravel bike hire"] },
  ]);
  expect(filterCall?.body?.queryOverrides?.order).toEqual([{ column: "sales_analytics_gross_takings", direction: "asc" }]);
  await expect(products.locator("tbody tr")).toHaveCount(1);
  await expect(products.getByRole("cell", { name: "Gravel bike hire" })).toBeVisible();
  // The filter card reads back in words and can be removed.
  await expect(page.getByRole("dialog", { name: "Filters for Top products by revenue" })).toContainText("Product is Gravel bike hire");
  await page.getByRole("button", { name: "Remove filter on Product" }).click();
  await expect(products.locator("tbody tr")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // A right-clicked value keeps only that value.
  await products.getByRole("cell", { name: "Helmets" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Keep only" }).click();
  await expect(products.locator("tbody tr")).toHaveCount(1);
  await expect(products.getByRole("cell", { name: "Helmets" })).toBeVisible();
  await page.screenshot({ path: ".playwright/dashboard-element-filters.png" });
});

test("Element properties requery the governed query in place and author the column contract", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { dashboardApplied: true });
  await page.goto("/dash");
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await page.getByRole("list", { name: "Your dashboards" }).getByRole("button", { name: /^Ashburton at a glance/u }).click();
  const chart = page.getByRole("region", { name: "Revenue by week" });
  await expect(chart).toBeVisible();

  // Sigma's Properties: Truncate date is one deterministic requery. The
  // element keeps its chart while the server re-mints the recipe.
  await chart.getByRole("button", { name: "Properties for Revenue by week" }).click();
  const properties = page.getByRole("complementary", { name: "Element editor for Revenue by week" });
  await expect(properties.getByRole("combobox", { name: "Truncate date" })).toHaveValue("week");
  await expect(properties.getByRole("combobox", { name: "Date range" })).toHaveValue("last 12 weeks");
  await properties.getByRole("combobox", { name: "Truncate date" }).selectOption("month");
  await expect(chart.getByRole("progressbar", { name: "Updating Revenue by week" })).toBeVisible();
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "query"
  )).length).toBe(1);
  const requery = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "query"
  )) as { tileId?: string; body?: { edits?: unknown; recipeVersion?: number; dashboardId?: string } } | undefined;
  expect(requery?.tileId).toBe("01J00000000000000000DBT301");
  expect(requery?.body?.edits).toEqual([{ op: "set_granularity", dimension: "sales_analytics.completed_at", granularity: "month" }]);
  expect(requery?.body?.recipeVersion).toBe(1);
  expect(requery?.body?.dashboardId).toBe("01J00000000000000000DBRD01");
  await expect(chart.getByRole("progressbar")).toHaveCount(0);
  // The new recipe's fields are re-read for the next edit.
  await expect(properties.getByRole("combobox", { name: "Truncate date" })).toHaveValue("month");
  await page.keyboard.press("Escape");

  // A table element: column order and visibility are authored state, not
  // result-set order; the column menu deletes a column from the query.
  const products = page.getByRole("region", { name: "Top products by revenue" });
  await products.getByRole("button", { name: "Properties for Top products by revenue" }).click();
  const tableProperties = page.getByRole("complementary", { name: "Element editor for Top products by revenue" });
  await tableProperties.getByRole("button", { name: "Move Gross takings up" }).click();
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  )).length).toBe(1);
  const orderCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  )) as { body?: { columnOrder?: unknown } } | undefined;
  expect(orderCall?.body?.columnOrder).toEqual(["sales_analytics_gross_takings", "sales_analytics_product"]);
  await expect(products.locator("thead th").first()).toContainText("Gross takings");
  await tableProperties.getByRole("button", { name: "Hide Product" }).click();
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  )).length).toBe(2);
  const hideCall = capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "tile"
  ))[1] as { body?: { columnPresentation?: unknown } } | undefined;
  expect(hideCall?.body?.columnPresentation).toEqual({ sales_analytics_product: { hidden: true } });
  await expect(products.locator("thead th")).toHaveCount(1);
  await tableProperties.getByRole("button", { name: "Show Product" }).click();
  await expect(products.locator("thead th")).toHaveCount(2);
  await page.keyboard.press("Escape");

  await products.getByRole("button", { name: "Column options for Gross takings" }).click();
  await page.getByRole("menuitem", { name: "Delete column" }).click();
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "query"
  )).length).toBe(2);
  const removeCall = capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "query"
  ))[1] as { tileId?: string; body?: { edits?: unknown } } | undefined;
  expect(removeCall?.tileId).toBe("01J00000000000000000DBT401");
  expect(removeCall?.body?.edits).toEqual([{ op: "remove_measure", member: "sales_analytics.gross_takings" }]);
  await page.screenshot({ path: ".playwright/dashboard-element-properties.png" });
});

test("The Albert wand reworks one element in place", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { dashboardApplied: true });
  await page.goto("/dash");
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await page.getByRole("list", { name: "Your dashboards" }).getByRole("button", { name: /^Ashburton at a glance/u }).click();
  const trend = page.getByRole("region", { name: "Revenue by week" });
  await expect(trend).toBeVisible();

  // The wand on the element: one sentence, sent as a scoped edit.
  await trend.getByRole("button", { name: "Edit Revenue by week with Albert" }).click();
  const ask = page.getByRole("textbox", { name: /What should change about/u });
  await ask.fill("make it daily for the last 30 days");
  await page.getByRole("dialog", { name: "Edit Revenue by week with Albert" })
    .getByRole("button", { name: "Edit with Albert" }).click();

  // The edit runs as a dashboard-mode turn scoped to the tile: the brief
  // names the element, the runtime composes one replacement, and the apply
  // replaces that tile in its slot.
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "build"
  )).length).toBe(1);
  const briefCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "build"
  )) as { body?: { instruction?: string; dashboardId?: string; tileId?: string } } | undefined;
  expect(briefCall?.body?.instruction).toBe("make it daily for the last 30 days");
  expect(briefCall?.body?.dashboardId).toBe("01J00000000000000000DBRD01");
  expect(briefCall?.body?.tileId).toBe("01J00000000000000000DBT301");
  const panel = page.getByRole("complementary", { name: "Dashboard preview" });
  await expect(panel).toBeVisible();
  // The chat shows the owner's words as an edit of that element.
  await expect(page.locator("p", { hasText: "Edit “Revenue by week”: make it daily for the last 30 days" })).toBeVisible();
  await expect.poll(() => capture.dashboardBuildPayloads.filter((entry) => (
    (entry as { endpoint?: string }).endpoint === "apply"
  )).length).toBe(1);
  const applyCall = capture.dashboardBuildPayloads.find((entry) => (
    (entry as { endpoint?: string }).endpoint === "apply"
  )) as { body?: { replaceTileId?: string; dashboardId?: string; conversationId?: string } } | undefined;
  expect(applyCall?.body?.replaceTileId).toBe("01J00000000000000000DBT301");
  expect(applyCall?.body?.dashboardId).toBe("01J00000000000000000DBRD01");
  expect(applyCall?.body?.conversationId).toBe("01J00000000000000000DBCV02");
  // The replacement sits where the old element was; nothing else moved.
  await expect(panel.getByRole("region", { name: "Revenue by day" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Revenue by week" })).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Revenue", exact: true })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Top products by revenue" })).toBeVisible();
  await page.screenshot({ path: ".playwright/dashboard-element-edit.png" });
});

test("Omni renders a composed pivot as an open pivot card and pins it", async ({ page }) => {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");
  await expectAnalysisRuntime(page, "Omni");
  const composer = page.getByRole("textbox", { name: "Ask Omni about your business" });
  await composer.fill("Show me sales and gross profit by week for the last 2 weeks.");
  await composer.press("Enter");

  // The composed pivot is the product of the turn: its card opens expanded,
  // drawn by the dashboard pivot renderer, not as a collapsed query.
  const pivotCard = page.getByRole("region", { name: "Pivot: Weekly scorecard" });
  await expect(pivotCard).toBeVisible();
  await expect(pivotCard.getByRole("button", { name: /Weekly scorecard/u })).toHaveAttribute("aria-expanded", "true");
  const pivotTable = pivotCard.locator("table[data-pivot='true']");
  await expect(pivotTable).toBeVisible();
  await expect(pivotTable.getByRole("columnheader", { name: /^Values/u })).toBeVisible();
  await expect(pivotTable.getByRole("columnheader", { name: "27 Jul", exact: true })).toBeVisible();
  await expect(pivotTable.getByRole("rowheader", { name: "Gross profit", exact: true })).toBeVisible();
  // Row units carry into the cells: currency down the Sales row.
  await expect(pivotTable.getByRole("cell", { name: "Sales, 27 Jul: $8,379.02", exact: true })).toHaveText("$8,379.02");
  const metricCell = await pivotTable.getByRole("rowheader", { name: "Sales", exact: true })
    .evaluate((cell) => getComputedStyle(cell).position);
  expect(metricCell).toBe("sticky");

  // The plain evidence query stays collapsed, as before.
  await expect(page.getByRole("region", { name: "Query: Weekly revenue" }).getByRole("button", { name: /Weekly revenue/u }))
    .toHaveAttribute("aria-expanded", "false");

  // One click pins the pivot to the dashboard through the governed pin route.
  await pivotCard.getByRole("button", { name: "Add to dashboard" }).click();
  await expect(pivotCard.getByRole("button", { name: "Added to dashboard" })).toBeVisible();
  const pin = capture.dashboardBuildPayloads.find((entry) => (
    (entry as Record<string, unknown>).endpoint === "pin"
  )) as Record<string, unknown> | undefined;
  expect(pin).toBeTruthy();
  expect((pin?.body as Record<string, unknown>).tableEventId).toBe("omni_fx_pivot_table");
  expect((pin?.body as Record<string, unknown>).resultId).toBe("01J0000000000000000000OMP1");
  await page.screenshot({ path: ".playwright/omni-pivot-card.png" });
});

test("Swarm on the Omni tab keeps the omni harness end to end", async ({ page }) => {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");
  await expectAnalysisRuntime(page, "Omni");

  // Toggling Swarm must not yank the conversation over to Codex.
  await page.getByTestId("model-run-controls-trigger").click();
  await page.getByRole("switch", { name: "Swarm" }).click();
  await page.keyboard.press("Escape");
  await expectAnalysisRuntime(page, "Omni");

  const composer = page.getByRole("textbox", { name: "Ask a harder question for Swarm" });
  await composer.fill("Where is the business leaking money across sales, costs and labour?");
  await composer.press("Enter");

  // The run registers on the omni harness and the fleet fans out through the
  // omni conversation endpoint.
  await expect.poll(() => capture.swarmPayloads.length).toBe(1);
  const swarmBody = capture.swarmPayloads[0] as Record<string, unknown>;
  expect(swarmBody.runtime).toBe("omni");
  await expect.poll(() => capture.omniConversationPayloads.length).toBeGreaterThan(0);
  const workerBody = capture.omniConversationPayloads.at(-1) as Record<string, unknown>;
  expect(workerBody.message).toBe("Measure the sales trajectory for the governed period.");
  expect(workerBody).not.toHaveProperty("solPlanner");
  expect(workerBody).not.toHaveProperty("proMode");

  // The panel tracks the omni worker and the conversation stays on Omni.
  await expect(page.getByRole("heading", { name: "Sales trajectory" }).or(page.getByText("Sales trajectory")).first()).toBeVisible();
  await expectAnalysisRuntime(page, "Omni");
});

test("Discover lists questions drawn from the connected tools and sends one to Omni", async ({ page }) => {
  const capture = await openDashboard(page);
  await page.getByRole("tab", { name: "Discover" }).click();
  await expect(page.getByRole("tab", { name: "Discover" })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByTestId("discover-workspace");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("heading", { name: "What’s possible with your data", level: 2 })).toBeVisible();
  // The header states its purpose in one line; the connected tools are the logo stack beside it.
  await expect(panel.locator("header")).toContainText("Pick one and Albert investigates.");
  await expect(panel.locator("header img")).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "Ask Omni about your business" })).toHaveCount(0);

  const expected = selectDiscoverCards(["xero", "deputy"]);
  const cards = page.getByTestId("discover-card");
  await expect(cards).toHaveCount(expected.length);
  await expect(cards.first()).toHaveAttribute("aria-label", `Ask: ${expected[0]!.prompt}`);
  await expect(cards.first().locator("img")).toHaveCount(expected[0]!.tools.length);
  await expectNoWcagViolations(page, "Discover grid");

  await page.getByRole("button", { name: "Cash & accounts", exact: true }).click();
  await expect(cards.first()).toHaveAttribute("data-domain", "cash");
  await expect(cards).toHaveCount(expected.filter((card) => card.domain === "cash").length);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(cards).toHaveCount(expected.length);

  await cards.first().click();
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  await expectAnalysisRuntime(page, "Omni");
  await expect.poll(() => capture.omniConversationPayloads.length).toBe(1);
  expect(capture.omniConversationPayloads[0]).toMatchObject({ message: expected[0]!.prompt });
  expect(capture.omniConversationPayloads[0]).not.toHaveProperty("dashboardBuild");
  await expect(page.getByText(expected[0]!.prompt, { exact: true })).toBeVisible();
  expect(capture.discoverPayloads).toHaveLength(1);

  // An ordinary answer whose tables carry pinning replay references must not
  // read as a dashboard build: no design narration, no dashboard preview.
  await expect(page.getByText(/Revenue held steady across the last 12 complete weeks/u)).toBeVisible();
  await expect(page.getByText(/Composing the dashboard|Creating element|Reading your data model|Planning the dashboard/u)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /dashboard preview/u })).toHaveCount(0);
});

test("Scheduled turns a description into a schedule, edits it in place and runs it on demand", async ({ page }) => {
  const capture = await openDashboard(page);
  await page.getByRole("tab", { name: "Scheduled" }).click();
  await expect(page.getByRole("tab", { name: "Scheduled" })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByTestId("scheduled-workspace");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reports on your schedule", level: 2 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask Omni about your business" })).toHaveCount(0);

  // The standing schedule lists with its cadence, zone, destination and last run.
  const tasks = page.getByTestId("scheduled-task");
  await expect(tasks).toHaveCount(1);
  await expect(tasks.first()).toContainText("Every day at 9:00 am · Australia/Melbourne · to Tom · +61 414 187 820");
  await expect(tasks.first().getByTestId("scheduled-next")).toContainText(/Next .*9:00 am/u);
  await expect(tasks.first().getByTestId("scheduled-last-run")).toContainText(/Sent .*9:00 am/u);
  await expectNoWcagViolations(page, "Scheduled list");

  // Describe a report; the deterministic reading sets the time and days.
  await page.getByRole("textbox", { name: "Describe a report and when to send it" })
    .fill("Every Monday at 8:30am text me last week's sales vs the week before");
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByTestId("scheduled-created")).toContainText("Scheduled.");
  await expect(tasks).toHaveCount(2);
  const created = tasks.nth(1);
  await expect(created).toContainText("Mondays at 8:30 am · Australia/Melbourne");
  await expect(created.getByRole("textbox", { name: /^Question for/u })).toHaveValue("Last week's sales vs the week before.");
  const createPayload = capture.scheduledPayloads.find((entry) => (entry as { body?: { action?: string } }).body?.action === "create");
  expect(createPayload).toMatchObject({
    method: "POST",
    body: { action: "create", text: "Every Monday at 8:30am text me last week's sales vs the week before" },
  });

  // Time, days, zone and number are all editable in place; each change saves.
  await created.getByLabel(/^Time for/u).fill("09:15");
  await expect(created).toContainText("Mondays at 9:15 am");
  await created.getByRole("button", { name: "Friday", exact: true }).click();
  await expect(created).toContainText("Mon and Fri at 9:15 am");
  await created.getByLabel(/^Time zone for/u).selectOption("Australia/Brisbane");
  await expect(created).toContainText("Australia/Brisbane");
  await created.getByLabel(/^Send .* to$/u).selectOption("+61400000002");
  await expect(created).toContainText("to Sam · +61 400 000 002");
  const updates = capture.scheduledPayloads
    .map((entry) => (entry as { body?: Record<string, unknown> }).body)
    .filter((body) => body?.action === "update");
  expect(updates).toEqual(expect.arrayContaining([
    expect.objectContaining({ timeOfDay: "09:15" }),
    expect.objectContaining({ days: ["mon", "fri"] }),
    expect.objectContaining({ timezone: "Australia/Brisbane" }),
    expect.objectContaining({ phone: "+61400000002" }),
  ]));

  // Run now queues a manual run; the tab polls until the bridge reports it sent.
  await created.getByRole("button", { name: "Run now" }).click();
  await expect(created.getByRole("button", { name: /Sending/u })).toBeVisible();
  await expect(created.getByTestId("scheduled-last-run")).toContainText(/Sent /u, { timeout: 15_000 });
  await expect(created.getByRole("button", { name: "Run now" })).toBeEnabled();
  expect(capture.scheduledPayloads.some((entry) => (entry as { body?: { action?: string } }).body?.action === "run")).toBe(true);

  // Pausing clears the next run; the schedule stays listed.
  await created.getByRole("switch", { name: /schedule on$/u }).click();
  await expect(created.getByTestId("scheduled-next")).toHaveText("Paused");

  // A run's analysis opens as an ordinary conversation in Chat.
  await tasks.first().getByRole("button", { name: "View analysis" }).click();
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
});

test("Alerts lists the ten triggers with their readings, switches recipients and runs a check on demand", async ({ page }) => {
  const capture = await openDashboard(page);
  await page.getByRole("tab", { name: "Alerts" }).click();
  await expect(page.getByRole("tab", { name: "Alerts" })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByTestId("alerts-workspace");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alerts", level: 2 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask Omni about your business" })).toHaveCount(0);

  // Ten catalogue triggers, each a title, a few words, who it goes to and
  // when it last fired; the status line carries the last check and how far
  // each tool's data reaches.
  const cards = page.getByTestId("alerts-trigger");
  await expect(cards).toHaveCount(10);
  await expect(page.getByTestId("alerts-status")).toContainText("Lightspeed to");
  await expect(page.getByTestId("alerts-status")).toContainText("Xero to");
  const trading = cards.filter({ has: page.getByRole("heading", { name: "Trading day", level: 3 }) });
  await expect(trading).toContainText("Record days, dead days, quiet months.");
  await expect(trading).not.toContainText("best day in 12 months");
  await expect(trading.getByTestId("alerts-last-fired")).toContainText("Last fired");
  await expect(trading.getByRole("button", { name: /^You /u })).toHaveAttribute("aria-pressed", "true");
  await expect(trading.getByRole("button", { name: /^Sam /u })).toHaveAttribute("aria-pressed", "false");
  const aged = cards.filter({ has: page.getByRole("heading", { name: "Bike on the floor a year", level: 3 }) });
  await expect(aged.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("alerts-events")).toContainText("Biggest day in a year");
  await expectNoWcagViolations(page, "Alerts list");

  // Adding a recipient and flipping a switch each save in place.
  await trading.getByRole("button", { name: /^Sam /u }).click();
  await expect(trading.getByRole("button", { name: /^Sam /u })).toHaveAttribute("aria-pressed", "true");
  await aged.getByRole("switch").click();
  await expect(aged.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  const updates = capture.alertsPayloads
    .map((entry) => (entry as { body?: Record<string, unknown> }).body)
    .filter((body) => body?.action === "update");
  expect(updates).toEqual(expect.arrayContaining([
    expect.objectContaining({ triggerKey: "trading_day", recipients: ["+61414187820", "+61400000002"] }),
    expect.objectContaining({ triggerKey: "aged_bike", enabled: true }),
  ]));

  // Check now queues an evaluation; the tab polls until the bridge reports it finished.
  await page.getByTestId("alerts-check").click();
  await expect(page.getByTestId("alerts-status")).toContainText(/Check queued|Checking/u);
  await expect(page.getByTestId("alerts-status")).toContainText(/^Checked /u, { timeout: 15_000 });
  await expect(page.getByTestId("alerts-check")).toBeEnabled();
  expect(capture.alertsPayloads.some((entry) => (entry as { body?: { action?: string } }).body?.action === "check")).toBe(true);
});

test("the raw debugger opens from the composer's run settings", async ({ page }) => {
  await openDashboard(page);
  await expect(page.getByRole("button", { name: "Raw debugger" })).toHaveCount(0);
  await page.getByTestId("model-run-controls-trigger").click();
  const toggle = page.getByRole("switch", { name: "Raw debugger" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Raw debugger", { exact: true }).last()).toBeVisible();
});

test("Dashboard Master runs a session through the omni harness and renders the report", async ({ page }) => {
  const capture = await installAppApiRoutes(page);
  await page.goto("/dash");

  await page.getByRole("button", { name: "Dashboard Master" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard Master" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your daily deep dive" })).toBeVisible();

  // Start the first session: one objective fans out through the omni
  // conversation endpoint with Luna at max effort.
  await page.getByRole("button", { name: "Run the first deep dive" }).click();
  await expect(page.getByText("Deep-dive session in progress")).toBeVisible();
  await expect.poll(() => capture.omniConversationPayloads.length).toBeGreaterThan(0);
  const workerBody = capture.omniConversationPayloads.at(-1) as Record<string, unknown>;
  expect(workerBody.message).toBe("Investigate the sales trajectory for the daily dashboard.");
  expect((workerBody.preferences as Record<string, unknown>).model).toBe("gpt-5.6-luna");
  expect((workerBody.preferences as Record<string, unknown>).reasoningEffort).toBe("max");

  // The worker's governed evidence is captured from the stream and recorded.
  await expect.poll(() => (capture.dashboardMasterPayloads as Array<{ endpoint: string }>)
    .filter((entry) => entry.endpoint === "finding").length).toBe(1);
  const finding = (capture.dashboardMasterPayloads as Array<{ endpoint: string; body: Record<string, unknown> }>)
    .find((entry) => entry.endpoint === "finding")!.body;
  expect(finding.key).toBe("sales-trajectory");
  expect(finding.failed).toBe(false);
  expect((finding.tables as unknown[]).length).toBe(1);
  expect(finding.queries).toBe(1);
  expect(finding.answerState).toBe("Verified");

  // Direction reaches compose and the composed report renders: hero headline,
  // five focus sections, key figures, evidence table and chart, actions.
  await expect.poll(() => (capture.dashboardMasterPayloads as Array<{ endpoint: string }>)
    .filter((entry) => entry.endpoint === "compose").length).toBe(1);
  await expect(page.getByRole("heading", { name: "Margins, not sales volume, are the biggest profit lever this month." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stop the discount leakage on bikes" })).toBeVisible();
  await expect(page.getByText("Fixture focus area 5")).toBeVisible();
  await expect(page.getByText("$5,209.42").first()).toBeVisible();
  await expect(page.getByText("214 governed queries")).toBeVisible();
  const evidenceCell = page.getByRole("cell", { name: "AUD 8,120.50" });
  await expect(evidenceCell).toBeVisible();
  await expect(page.locator("figure").filter({ hasText: "Weekly revenue trend" }).locator("svg").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Set a discount approval threshold for anything over 10%.").first()).toBeVisible();
  await expect(page.getByText("The latest labour week is partial; wage ratios exclude it.")).toBeVisible();

  // The report must be user-scrollable: an overflow-auto ancestor that
  // actually scrolls. (Playwright's own visibility auto-scroll also works on
  // overflow-hidden containers, so assert the real property instead.)
  const scrolled = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h1")]
      .find((el) => el.textContent?.startsWith("Margins, not sales volume"));
    let node = heading?.parentElement ?? null;
    while (node) {
      const style = getComputedStyle(node);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
        node.scrollTop = 500;
        return node.scrollTop;
      }
      node = node.parentElement;
    }
    return -1;
  });
  expect(scrolled).toBeGreaterThan(0);
});
