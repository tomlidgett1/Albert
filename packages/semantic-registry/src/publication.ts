import type { RegistryDocument } from "./schema.js";
import { registryDigest } from "./load.js";

export const SEMANTIC_REGISTRY_SCHEMA_VERSION = 1;

export type SemanticPublicationPlan = Readonly<{
  registryVersion: string;
  registryHash: string;
  schemaVersion: number;
  contractCount: number;
  topicCount: number;
  packVersions: Readonly<Record<string, string>>;
  manifest: Readonly<{
    schemaVersion: number;
    registryVersion: string;
    registryHash: string;
    metricIds: readonly string[];
    topicIds: readonly string[];
    factIds: readonly string[];
  }>;
}>;

/**
 * Creates the immutable deployment record for a semantic registry snapshot.
 * The plan intentionally contains identifiers rather than the full registry:
 * the executable registry remains the signed, versioned deployment artifact.
 */
export function createSemanticPublicationPlan(
  document: RegistryDocument,
  packVersions: Readonly<Record<string, string>>,
): SemanticPublicationPlan {
  const sortedPackVersions = Object.freeze(
    Object.fromEntries(
      Object.entries(packVersions)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  for (const [pack, version] of Object.entries(sortedPackVersions)) {
    if (!pack.trim() || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`Invalid connector pack publication entry: ${pack}@${version}`);
    }
  }

  const registryHash = registryDigest(document);
  const metricIds = Object.freeze(document.metrics.map(({ id }) => id).sort());
  const topicIds = Object.freeze(document.topics.map(({ id }) => id).sort());
  const factIds = Object.freeze(document.facts.map(({ id }) => id).sort());
  const manifest = Object.freeze({
    schemaVersion: SEMANTIC_REGISTRY_SCHEMA_VERSION,
    registryVersion: document.registryVersion,
    registryHash,
    metricIds,
    topicIds,
    factIds,
  });

  return Object.freeze({
    registryVersion: document.registryVersion,
    registryHash,
    schemaVersion: SEMANTIC_REGISTRY_SCHEMA_VERSION,
    contractCount: document.metrics.length,
    topicCount: document.topics.length,
    packVersions: sortedPackVersions,
    manifest,
  });
}
