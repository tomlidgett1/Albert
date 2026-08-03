import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";

export interface TransactionalPostgres extends PostgresQueryClient {
  transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T>;
}

export type ConnectionRuntimeRecord = Readonly<{
  tenantId: string;
  connectionId: string;
  connectorKey: "lightspeed-r" | "xero" | "deputy";
  externalAccountReference: string;
  credentialRef: string;
}>;
