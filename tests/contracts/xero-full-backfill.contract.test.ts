import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { XeroConnector } from "../../connectors/xero/index.js";
import { XERO_SPEC_TABLES } from "../../connectors/xero/scan-plan.js";
import { endpointPath, XERO_API_PROFILES } from "../../connectors/xero/spec-sync.js";
import { XERO_STREAMS } from "../../connectors/xero/streams.js";
import type {
  ConnectorContext,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";

/**
 * Drives every declared Xero stream through the real sync engine against the
 * sanitized recording. A stream that cannot be walked — a bad endpoint path, an
 * envelope the unwrapper cannot open, a fan-out with no reachable parent — is
 * a table that silently stays empty forever while the connector reports success.
 * This is the check that catches that, offline, for all of them at once.
 */

const fixture = JSON.parse(
  readFileSync(new URL("../../connectors/xero/fixtures/sanitized-recording.json", import.meta.url), "utf8"),
) as Readonly<{ responses: Readonly<Record<string, Readonly<Record<string, unknown>>>> }>;

const tableById = new Map(XERO_SPEC_TABLES.map((table) => [table.id, table]));

/** Region a payroll stream requires, so the gate sees a matching organisation. */
function regionFor(api: string): string {
  return api === "payroll_au" ? "AU" : api === "payroll_nz" ? "NZ" : api === "payroll_uk" ? "GB" : "AU";
}

class MemoryVault {
  constructor(private readonly secret: OAuthCredentialSecret) {}
  async read(): Promise<VersionedCredential> {
    return { credentialRef: "credential:test", revision: "1", secret: this.secret } as VersionedCredential;
  }
  async create(): Promise<VersionedCredential> { return this.read(); }
  async compareAndSwap(): Promise<VersionedCredential> { return this.read(); }
  async destroy(): Promise<void> {}
  async withRefreshLease<T>(_ref: string, work: (lease: never) => Promise<T>): Promise<T> {
    return work({ proof: "proof" } as never);
  }
}

const context: ConnectorContext = {
  tenantId: "tenant-test",
  connectionId: "connection-test",
  credentialRef: "credential:test",
} as ConnectorContext;

/**
 * Serve each stream's recorded envelope from the path its own contract walks,
 * so a stream that names the wrong endpoint gets nothing back and fails loudly.
 */
function buildFetcher(region: string): (input: RequestInfo | URL) => Promise<Response> {
  const byPath = new Map<string, unknown>();
  for (const stream of XERO_STREAMS) {
    const table = tableById.get(stream.id)!;
    const body = fixture.responses[stream.id];
    if (!body) continue;
    byPath.set(endpointPath(table).replace(/\{[^}]+\}/gu, "*"), body);
  }

  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/connections") {
      return Response.json([{
        id: "connection-1",
        tenantId: "xero-tenant",
        tenantType: "ORGANISATION",
        tenantName: "Demo Organisation",
      }]);
    }
    if (url.pathname === "/api.xro/2.0/Organisation") {
      return Response.json({
        Organisations: [{ OrganisationID: "org-1", Name: "Demo", CountryCode: region, BaseCurrency: "AUD" }],
      });
    }
    // Page 2+ of any walk is empty: every walk must terminate on an empty page.
    const page = url.searchParams.get("page");
    if (page && Number(page) > 1) return Response.json({});
    const offset = url.searchParams.get("offset");
    if (offset && Number(offset) > 0) return Response.json({});

    const generalised = url.pathname.replace(/\/[0-9a-f-]{8,}(?=\/|$)/giu, "/*");
    const body = byPath.get(url.pathname) ?? byPath.get(generalised);
    return Response.json(body ?? {});
  };
}

function connectorFor(region: string): XeroConnector {
  return new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    now: () => Date.parse("2026-08-06T00:00:00.000Z"),
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.settings.read"],
      metadata: { xeroTenantId: "xero-tenant", xeroConnectionId: "connection-1" },
    } as OAuthCredentialSecret) as unknown as WorkerCredentialVault,
    fetcher: buildFetcher(region) as never,
  });
}

test("every declared stream walks its own endpoint and terminates", async () => {
  const range = { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" };
  const byRegion = new Map<string, XeroConnector>();
  const emptyWalks: string[] = [];

  for (const stream of XERO_STREAMS) {
    const table = tableById.get(stream.id)!;
    const region = regionFor(table.source.api);
    if (!byRegion.has(region)) byRegion.set(region, connectorFor(region));
    const xero = byRegion.get(region)!;
    const contract = (await xero.list_streams(context)).find((candidate) => candidate.id === stream.id);
    assert.ok(contract, `${stream.id} is not exposed by list_streams`);

    const page = await xero.initial_sync(context, contract, range);
    assert.ok(page, `${stream.id} produced no page`);
    // A walk that reports more work must hand back a cursor to continue from.
    if (page.hasMore) assert.ok(page.nextCursor, `${stream.id} claims more pages with no cursor`);
    if (stream.projection === "walk" && page.records.length === 0) emptyWalks.push(stream.id);
  }

  assert.deepEqual(
    emptyWalks,
    [],
    "these streams walked their endpoint and projected nothing — their staging tables can never fill",
  );
});

test("every stream's endpoint path resolves under its API's documented base path", () => {
  for (const table of XERO_SPEC_TABLES) {
    const path = endpointPath(table);
    const profile = XERO_API_PROFILES[table.source.api];
    assert.ok(path.startsWith("/"), `${table.id} has a relative endpoint path`);
    if (table.source.api !== "identity") {
      assert.ok(
        path.startsWith(profile.basePath),
        `${table.id} walks ${path}, which is outside ${table.source.api}'s base path ${profile.basePath}`,
      );
    }
  }
});

test("no two streams stage into the same table", () => {
  const ids = XERO_STREAMS.map((stream) => stream.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, XERO_SPEC_TABLES.length);
});
