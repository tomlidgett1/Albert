import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";

export interface TransactionalPostgres extends PostgresQueryClient {
  transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T>;
}

export type ConnectionRuntimeRecord = Readonly<{
  tenantId: string;
  connectionId: string;
  connectorKey: "lightspeed-r" | "lightspeed-x" | "xero" | "deputy" | "square" | "shopify" | "stripe" | "momence" | "meta-ads" | "google-ads";
  externalAccountReference: string;
  accountMetadata: Readonly<Record<string, unknown>>;
  credentialRef: string;
  connectionGeneration: number;
}>;
