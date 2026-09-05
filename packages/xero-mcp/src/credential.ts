import { XERO_REPORT_SCOPES } from "../../../connectors/xero/manifest.js";
import type { ConnectorContext } from "../../connector-sdk/src/index.js";
import type { XeroConnector } from "../../../connectors/xero/index.js";
import type { WorkerCredentialVault } from "../../connector-sdk/src/index.js";
import type { XeroMcpOrganisation } from "./types.js";

export type XeroMcpCredentialQuery = {
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly T[] }>>;
};

export type ResolvedXeroMcpCredential = Readonly<{
  organisation: XeroMcpOrganisation;
  accessToken: string;
}>;

const PREFERRED_NAME = "Ashburton Cycles";

export async function resolveXeroMcpCredential(input: Readonly<{
  tenantId: string;
  db: XeroMcpCredentialQuery;
  vault: WorkerCredentialVault;
  connector: XeroConnector;
  signal?: AbortSignal;
}>): Promise<ResolvedXeroMcpCredential> {
  const found = await input.db.query<{
    connection_id: string;
    display_name: string;
    external_account_reference: string;
    secret_reference: string;
  }>(
    `select connection.connection_id,
            connection.display_name,
            connection.external_account_reference,
            token.secret_reference
       from control_plane.connections connection
       join lateral (
         select secret_reference
           from control_plane.oauth_token_refs
          where tenant_id = connection.tenant_id
            and connection_id = connection.connection_id
          order by updated_at desc
          limit 1
       ) token on true
      where connection.tenant_id = $1
        and connection.connector_key = 'xero'
        and connection.status in ('connected', 'degraded')
        and connection.external_account_reference is not null
      order by connection.authorised_at desc nulls last, connection.updated_at desc`,
    [input.tenantId],
  );
  if (found.rows.length === 0) {
    throw new Error("xero_mcp_connection_not_found");
  }
  // The most recently authorised grant is the live one: a re-consent (e.g.
  // Xero via Fivetran, which rides this same native grant) creates a new
  // connection row and the older row's token may no longer reach the org.
  // The org-name preference only breaks ties between equally fresh grants.
  const preferred = found.rows.find((row) => (
    row.display_name.trim().toLowerCase() === PREFERRED_NAME.toLowerCase()
    && row.connection_id === found.rows[0]!.connection_id
  ));
  const connection = preferred ?? found.rows[0]!;
  const context: ConnectorContext = {
    tenantId: input.tenantId,
    connectionId: connection.connection_id,
    credentialRef: connection.secret_reference,
    abortSignal: input.signal,
  };
  let credential = await input.vault.read(connection.secret_reference);
  if (Date.parse(credential.secret.expiresAt) < Date.now() + 25 * 60_000) {
    const refreshed = await input.connector.refresh_credentials(context);
    credential = await input.vault.read(refreshed.credentialRef);
  }
  if (!credential.secret.accessToken.trim()) {
    throw new Error("xero_mcp_token_missing");
  }
  const grantedScopes = [...credential.secret.scopes];
  const granted = new Set(grantedScopes);
  return {
    organisation: {
      tenantId: input.tenantId,
      connectionId: connection.connection_id,
      displayName: connection.display_name,
      xeroTenantId: connection.external_account_reference,
      grantedScopes,
      missingReportScopes: XERO_REPORT_SCOPES.filter((scope) => !granted.has(scope)),
    },
    accessToken: credential.secret.accessToken,
  };
}
