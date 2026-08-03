import type { Page } from "@playwright/test";
import { createDeterministicFixtureTrace } from "../../../services/conversation/src/fixture";

export const fixtureWorkspace = Object.freeze({
  tenantName: "Albert Bike Store",
  timezone: "Australia/Melbourne",
  syncSummary: Object.freeze({
    progress: 72,
    detail: "Recent sales and workforce data are ready while accounting history backfills.",
    latestActivityAt: "2026-08-04T01:42:00.000Z",
  }),
  providers: Object.freeze([
    Object.freeze({
      id: "lightspeed",
      name: "Lightspeed",
      description: "Sales, inventory, customers, and store activity.",
      logo: "/logos/lightspeed.png",
      connectDetail: "Connect a Lightspeed Retail R-Series account.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "xero",
      name: "Xero",
      description: "Accounting, invoices, journals, and bank activity.",
      logo: "/logos/xero.svg",
      connectDetail: "Connect a Xero organisation.",
      additionalConnectionLabel: "Add another Xero organisation",
      connections: Object.freeze([
        Object.freeze({
          connectionId: "01J00000000000000000000XR1",
          auth: Object.freeze({
            state: "healthy",
            label: "Connected",
            detail: "Token checked moments ago",
            accountName: "Albert Bike Store Pty Ltd",
            checkedAt: "2026-08-04T01:41:00.000Z",
          }),
          domains: Object.freeze([
            Object.freeze({
              id: "finance",
              label: "Accounting",
              state: "ready_partial",
              detail: "Current accounting period is queryable; deep history is backfilling.",
              progress: 63,
              watermark: Object.freeze({
                label: "Ready through 11:41 am",
                at: "2026-08-04T01:41:00.000Z",
              }),
            }),
          ]),
        }),
      ]),
    }),
    Object.freeze({
      id: "deputy",
      name: "Deputy",
      description: "Rosters, timesheets, leave, and workforce activity.",
      logo: "/logos/deputy.png",
      connectDetail: "Connect a Deputy installation.",
      connections: Object.freeze([
        Object.freeze({
          connectionId: "01J00000000000000000000DP1",
          auth: Object.freeze({
            state: "healthy",
            label: "Connected",
            detail: "Melbourne install",
            accountName: "Albert Bike Store",
            checkedAt: "2026-08-04T01:40:00.000Z",
          }),
          domains: Object.freeze([
            Object.freeze({
              id: "workforce",
              label: "Workforce",
              state: "ready_complete",
              detail: "Rosters, timesheets, and leave are queryable.",
              progress: 100,
              watermark: Object.freeze({
                label: "Ready through 11:40 am",
                at: "2026-08-04T01:40:00.000Z",
              }),
            }),
          ]),
        }),
      ]),
    }),
  ]),
  dossier: Object.freeze([
    Object.freeze({
      id: "dossier-industry",
      label: "Industry",
      value: "Independent bicycle retail",
      confidence: Object.freeze({ label: "High", percent: 96 }),
      provenance: "Lightspeed category and product mix",
      observedAt: "2026-08-04T01:38:00.000Z",
    }),
  ]),
  blockingQuestions: Object.freeze([
    Object.freeze({
      id: "sales-tax-lens",
      label: "Sales definition",
      question: "Should sales normally include or exclude GST?",
      options: Object.freeze([
        Object.freeze({ id: "exclude-gst", label: "Exclude GST" }),
        Object.freeze({ id: "include-gst", label: "Include GST" }),
      ]),
    }),
  ]),
  identityMatches: Object.freeze([
    Object.freeze({
      id: "identity-jess",
      kind: "worker",
      title: "Is this the same employee?",
      first: Object.freeze({ provider: "deputy", providerLabel: "Deputy", value: "Jessica Chen" }),
      second: Object.freeze({ provider: "lightspeed", providerLabel: "Lightspeed", value: "Jess C" }),
      evidence: "Same work email and primary Melbourne location.",
      confidence: "High",
      decision: "proposed",
      projectionStatus: "applied",
    }),
  ]),
  oauthSelections: Object.freeze([
    Object.freeze({
      oauthSessionId: "01J0000000000000000000OS1",
      provider: "xero",
      providerLabel: "Xero",
      expiresAt: "2026-08-04T02:00:00.000Z",
      accounts: Object.freeze([
        Object.freeze({ id: "xero-account-1", label: "Albert Bike Store Pty Ltd", detail: "AU organisation" }),
        Object.freeze({ id: "xero-account-2", label: "Albert Workshop Pty Ltd", detail: "AU organisation" }),
      ]),
    }),
  ]),
});

export type AppApiCapture = {
  bootstrapPayloads: unknown[];
  conversationPayloads: unknown[];
  oauthSelectionPayloads: unknown[];
  reviewPayloads: unknown[];
};

export async function installSupabaseBrowserAuthRoutes(page: Page): Promise<void> {
  await page.route(/^https:\/\/abcdefghijklmnopqrst\.supabase\.co\/auth\/v1\//u, async (route) => {
    const request = route.request();
    const sourceUrl = new URL(request.url());
    const localUrl = `http://127.0.0.1:55431${sourceUrl.pathname}${sourceUrl.search}`;
    const headers = { ...request.headers() };
    delete headers.host;
    delete headers["content-length"];
    const response = await fetch(localUrl, {
      method: request.method(),
      headers,
      body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

export async function installAppApiRoutes(
  page: Page,
  options: Readonly<{ needsBootstrap?: boolean }> = {},
): Promise<AppApiCapture> {
  await installSupabaseBrowserAuthRoutes(page);
  const capture: AppApiCapture = {
    bootstrapPayloads: [],
    conversationPayloads: [],
    oauthSelectionPayloads: [],
    reviewPayloads: [],
  };
  let bootstrapped = false;

  await page.route(/\/api\/session(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON();
      capture.bootstrapPayloads.push(payload);
      bootstrapped = true;
      await route.fulfill({
        status: 201,
        json: { context: { tenant_name: "Albert Bike Store", role: "owner" } },
      });
      return;
    }

    await route.fulfill({
      json: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "owner@example.com",
          suggestedOrganisationName: "Albert Bike Store",
          timezone: "Australia/Melbourne",
        },
        context: options.needsBootstrap && !bootstrapped
          ? null
          : { tenant_name: "Albert Bike Store", role: "owner" },
        internalOperator: false,
        deletionReceipt: null,
        needsBootstrap: Boolean(options.needsBootstrap && !bootstrapped),
      },
    });
  });

  await page.route(/\/api\/connections(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: { workspace: fixtureWorkspace } });
  });

  await page.route(/\/api\/connections\/review$/u, async (route) => {
    capture.reviewPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { accepted: true } });
  });

  await page.route(/\/api\/oauth\/select$/u, async (route) => {
    capture.oauthSelectionPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { connected: true } });
  });

  await page.route(/\/api\/conversations(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: { conversations: [] } });
  });

  await page.route(/\/api\/conversation$/u, async (route) => {
    capture.conversationPayloads.push(route.request().postDataJSON());
    const body = createDeterministicFixtureTrace()
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    await route.fulfill({
      status: 200,
      body,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Albert-Runtime": "fixture",
      },
    });
  });

  return capture;
}
