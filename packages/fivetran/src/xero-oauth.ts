const TOKEN_ENDPOINT = "https://identity.xero.com/connect/token";

export type XeroOAuthTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
}>;

export async function exchangeXeroAuthorizationCode(input: Readonly<{
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetcher?: typeof fetch;
}>): Promise<XeroOAuthTokens> {
  const fetcher = input.fetcher ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const response = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret ?? ""}`, "utf8").toString("base64")}`,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null) as {
    access_token?: unknown;
    refresh_token?: unknown;
    error?: unknown;
  } | null;
  if (
    !response.ok
    || typeof payload?.access_token !== "string"
    || !payload.access_token
    || typeof payload.refresh_token !== "string"
    || !payload.refresh_token
  ) {
    throw new Error("oauth_exchange_failed");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
  };
}

export type XeroTenantConnection = Readonly<{
  tenantId: string;
  tenantName?: string;
}>;

export async function listXeroTenants(input: Readonly<{
  accessToken: string;
  fetcher?: typeof fetch;
}>): Promise<readonly XeroTenantConnection[]> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher("https://api.xero.com/connections", {
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error("oauth_tenant_discovery_failed");
  }
  return payload.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const tenantId = "tenantId" in item && typeof item.tenantId === "string" ? item.tenantId.trim() : "";
    if (!tenantId || tenantId.length > 80) return [];
    const tenantName = "tenantName" in item && typeof item.tenantName === "string"
      ? item.tenantName.trim().slice(0, 160)
      : undefined;
    return [{ tenantId, ...(tenantName ? { tenantName } : {}) }];
  });
}
