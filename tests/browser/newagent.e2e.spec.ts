import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ulid } from "ulid";
import { installAppApiRoutes } from "./support/app-fixtures";

for (const theme of ["light", "dark", "system"] as const) {
  test(`newagent uses view2 and its dedicated harness in ${theme} mode`, async ({ page }) => {
    await installAppApiRoutes(page);
    await page.addInitScript((theme) => localStorage.setItem("albert-theme", theme), theme);
    await page.emulateMedia({ colorScheme: theme === "light" ? "light" : "dark", reducedMotion: "reduce" });
    const requests: Record<string, unknown>[] = [];
    let omniCalls = 0;
    const conversationId = ulid();
    await page.route("**/api/omni-conversation", (route) => { omniCalls += 1; return route.abort(); });
    await page.route("**/api/newagent-conversation", (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const events = [
        { type: "progress", status: "running", stage: "planning", label: "Checking the recorded evidence" },
        { type: "answer", status: "complete", state: "Qualified", text: `Managed agent reply ${requests.length}.`, followUps: [], presentedResultIds: [], claims: [], provenance: {
          sources: [], timeRange: { label: "Synthetic test", timezone: "Australia/Melbourne" }, definitions: [],
          semanticBundleHash: "synthetic-test", identityGraph: { version: 0, hash: "synthetic-test" },
        } },
      ].map((event, index) => ({ ...event, id: ulid(), sequence: index + 1, occurredAt: new Date().toISOString() }));
      return route.fulfill({ status: 200, headers: {
        "content-type": "text/event-stream", "X-Albert-Runtime": "newagent", "X-Albert-Model": body.preferences.model,
        "X-Albert-Conversation-Id": conversationId, "X-Albert-Turn-Id": ulid(),
      }, body: events.map((event) => `event: trace\ndata: ${JSON.stringify(event)}\n\n`).join("") });
    });
    await page.goto("/newagent?mode=view2&runtime=codex");
    await expect(page.locator('[data-agent-harness="openai-agents-api"]')).toBeVisible();
    await expect(page.locator('[data-chat-runtime="newagent"]')).toBeVisible();
    await expect(page.getByText("Agents API", { exact: true })).toBeVisible();
    await expect(page.locator('[data-agent-harness="openai-agents-api"] > aside')).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: "Ask the new agent about your business" });
    await composer.fill("Check the synthetic evidence.");
    await composer.press("Enter");
    await expect(page.getByText("Managed agent reply 1.", { exact: true })).toBeVisible();
    await composer.fill("Explain that result.");
    await composer.press("Enter");
    await expect(page.getByText("Managed agent reply 2.", { exact: true })).toBeVisible();
    expect(requests[1]?.conversationId).toBe(conversationId);
    expect(requests[0]?.preferences).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "high", fastMode: false });
    expect(omniCalls).toBe(0);
    await page.locator('button[aria-keyshortcuts="Alt+N"]').click();
    await expect(composer).toHaveValue("");
    await expect(page.locator('[data-chat-runtime="newagent"]')).toBeVisible();
    await page.screenshot({ path: `.playwright/newagent-${theme}.png`, fullPage: true });
    const accessibility = await new AxeBuilder({ page }).include('[data-agent-harness="openai-agents-api"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations.filter((issue) => issue.impact === "critical" || issue.impact === "serious")).toEqual([]);
  });
}

test("newagent remains usable on a narrow view2 canvas", async ({ page }) => {
  await installAppApiRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/newagent");
  await expect(page.getByRole("textbox", { name: "Ask the new agent about your business" })).toBeVisible();
  await expect(page.locator('button[aria-keyshortcuts="Alt+N"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".playwright/newagent-mobile-dark.png", fullPage: true });
});

test("newagent preserves the authenticated page boundary", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto("/newagent");
    await expect(page).toHaveURL(/\/login\?next=%2Fnewagent/u);
    const rejected = await context.request.post("/api/newagent-conversation", { data: { message: "test" }, headers: { origin: "https://untrusted.example" } });
    expect(rejected.status()).toBe(403);
  } finally { await context.close(); }
});
