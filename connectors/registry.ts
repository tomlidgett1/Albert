import type {
  ConnectorId,
  ConnectorManifest,
} from "../packages/connector-sdk/src/index.js";
import { deputyManifest } from "./deputy/manifest.js";
import { lightspeedRManifest } from "./lightspeed-r/manifest.js";
import { xeroManifest } from "./xero/manifest.js";

/**
 * The explicit composition root for installed connector packs. Generic
 * runtimes consume this registry and do not branch on vendor identities.
 */
export const connectorManifests = Object.freeze([
  lightspeedRManifest,
  xeroManifest,
  deputyManifest,
] as const satisfies readonly ConnectorManifest[]);

const manifestById = new Map<ConnectorId, ConnectorManifest>(
  connectorManifests.map((manifest) => [manifest.id, manifest]),
);

export function connectorManifest(connectorId: ConnectorId): ConnectorManifest {
  const manifest = manifestById.get(connectorId);
  if (!manifest) throw new Error(`connector_manifest_missing:${connectorId}`);
  return manifest;
}
