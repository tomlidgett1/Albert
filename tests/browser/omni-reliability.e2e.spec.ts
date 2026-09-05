import { expect, test } from "@playwright/test";
import { ulid } from "ulid";
import { installAppApiRoutes } from "./support/app-fixtures";
import { composeAnswer } from "../../packages/albert-omni/src/answer";
import type { PivotSourceResult } from "../../packages/albert-omni/src/pivot";

for (const theme of ["light", "dark"] as const) {
  test(`Omni composed figures keep their units in ${theme} mode`, async ({ page }) => {
    await installAppApiRoutes(page);
    await page.addInitScript((theme) => localStorage.setItem("albert-theme", theme), theme);
    await page.emulateMedia({ colorScheme: theme });
    const resultId = ulid();
    const source: PivotSourceResult = {
      resultId, topic: "Sales Analytics",
      columns: [{ key: "margin", label: "Margin", type: "percent", percentScale: "percent" }],
      rows: [{ margin: 0.5 }],
      semantics: { version: 1, completeness: "complete", returnedRows: 1, rowLimit: 500, grain: [], keys: {}, window: "fixture", queryDigest: "q", semanticVersionDigest: "s" },
      provenance: { sources: [{ connector: "lightspeed", label: "Fixture sales", dataThrough: "2026-08-31" }], timeRange: { label: "August 2026", start: "2026-08-01", end: "2026-08-31", timezone: "Australia/Melbourne" }, definitions: [], semanticBundleHash: "fixture", identityGraph: { version: 0, hash: "fixture" } },
    };
    const composed = composeAnswer({ outcome: "answer", markdown: "Margin was **{{margin}}**.\n\n{{detail}}", values: [{ id: "margin", resultId, rowIndex: 0, columnKey: "margin", format: "auto", decimals: null }], tables: [{ id: "detail", resultId, columnKeys: ["margin"], limit: 1 }], citedResultIds: [resultId], limitations: [], followUps: [] }, new Map([[resultId, source]]), { question: "Show margin for August 2026", today: "2026-09-04" });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const events = [
      { type: "narrative", text: "I’ll check the recorded margin." },
      { type: "query", status: "complete", topic: "Sales Analytics", name: "Margin fixture", metrics: ["sales_analytics.gross_margin_pct"], dimensions: [], timeRange: source.provenance.timeRange, lens: "Cube view: sales_analytics", view: "sales_analytics", cubesUsed: [], queryYaml: "measures:\n  - sales_analytics.gross_margin_pct", rowCount: 1, executionMs: 1, connector: "lightspeed", resultId },
      { type: "table", status: "complete", caption: "Margin fixture", resultId, columns: source.columns, rows: source.rows, provenance: source.provenance, semantics: source.semantics, presentation: "evidence" },
      { type: "narrative", text: "Unfinished margin draft: {{margin}}. The final composition will resolve this." },
      { type: "narrative", text: "Truncated margin draft: {{marg" },
      { type: "answer", status: "complete", state: composed.answer.state, text: composed.answer.text, provenance: source.provenance, followUps: [], presentedResultIds: [resultId], claims: composed.answer.claims },
    ].map((event, index) => ({ ...event, id: ulid(), sequence: index + 1, occurredAt: new Date().toISOString() }));
    await page.route("**/api/omni-conversation", (route) => route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Albert-Runtime": "omni", "X-Albert-Model": String(route.request().postDataJSON().preferences?.model ?? "claude-haiku-4-5-20251001"), "X-Albert-Conversation-Id": "01J00000000000000000000071", "X-Albert-Turn-Id": "01J00000000000000000000072" }, body: events.map((event) => `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`).join("") }));
    await page.goto("/dash");
    const composer = page.getByRole("textbox", { name: "Ask Omni about your business" });
    await composer.fill("Show margin for August 2026");
    await composer.press("Enter");
    await expect(page.getByText("Margin was 0.5%.")).toBeVisible();
    await expect(page.getByText("I’ll check the recorded margin.")).toBeVisible();
    await expect(page.getByText(/Unfinished margin draft|Truncated margin draft/u)).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "0.5%", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Query.*Margin fixture/u }).click();
    await expect(page.getByRole("cell", { name: "+0.5%", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "+50%", exact: true })).toHaveCount(0);
    await expect(page.locator(`[data-theme="${theme}"]`).first()).toBeVisible();
    await page.screenshot({ path: `.playwright/omni-reliability-${theme}.png`, fullPage: true });
  });
}
