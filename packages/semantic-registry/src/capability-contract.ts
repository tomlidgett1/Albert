import {
  SEMANTIC_CAPABILITY_IDS,
  assertCapabilityIds,
  assertConnectorManifestReconciliationPolicy,
  type ConnectorManifest,
} from "../../connector-sdk/src/index.js";
import type { RegistryDocument } from "./schema.js";

/**
 * Deterministic producer/consumer check for the connector-to-semantic protocol.
 * A registry capability cannot ship unless a connector pack declares how a
 * successful source stream can observe it.
 */
export function assertCapabilityContract(
  document: RegistryDocument,
  manifests: readonly ConnectorManifest[],
): void {
  const consumed = new Set<string>([
    ...document.metrics.flatMap((metric) => metric.requiredCapabilities),
    ...document.topics.flatMap((topic) => topic.requiredCapabilities),
  ]);
  const vocabulary = new Set<string>(SEMANTIC_CAPABILITY_IDS);
  const missingConsumers = [...vocabulary].filter((capability) => !consumed.has(capability)).sort();
  const unknownConsumers = [...consumed].filter((capability) => !vocabulary.has(capability)).sort();
  if (missingConsumers.length || unknownConsumers.length) {
    throw new Error(
      `Semantic capability vocabulary mismatch; unused=[${missingConsumers.join(", ")}], unknown=[${unknownConsumers.join(", ")}].`,
    );
  }

  const producers = new Map<string, { connector: string; support: string }[]>();
  for (const manifest of manifests) {
    assertConnectorManifestReconciliationPolicy(manifest);
    const capabilityEntries = Object.entries(manifest.capabilities);
    assertCapabilityIds(capabilityEntries.map(([capability]) => capability), `${manifest.id} manifest`);
    const streamIds = new Set(manifest.streams.map((stream) => stream.id));
    for (const [capability, declaration] of capabilityEntries) {
      if (!declaration.reason.trim()) {
        throw new Error(`${manifest.id} capability ${capability} has no explicit reason.`);
      }
      const unknownStreams = declaration.streams.filter((stream) => !streamIds.has(stream));
      if (unknownStreams.length) {
        throw new Error(`${manifest.id} capability ${capability} references unknown streams: ${unknownStreams.join(", ")}.`);
      }
      if (declaration.requiresObservedCoverage && !declaration.coverageFields?.length) {
        throw new Error(`${manifest.id} capability ${capability} requires coverage but declares no fields.`);
      }
      for (const field of declaration.coverageFields ?? []) {
        const covered = manifest.fieldCoverage.some((entry) =>
          declaration.streams.includes(entry.stream) && entry.field === field,
        );
        if (!covered) {
          throw new Error(`${manifest.id} capability ${capability} measures undeclared field ${field}.`);
        }
      }
      const current = producers.get(capability) ?? [];
      current.push({ connector: manifest.id, support: declaration.support });
      producers.set(capability, current);
    }
  }

  const withoutProducer = [...consumed].filter((capability) => !producers.has(capability)).sort();
  if (withoutProducer.length) {
    throw new Error(`Semantic capabilities have no connector producer: ${withoutProducer.join(", ")}.`);
  }
  for (const topic of document.topics) {
    const permanentlyUnavailable = topic.requiredCapabilities.filter((capability) =>
      (producers.get(capability) ?? []).every((producer) => producer.support === "unavailable"),
    );
    if (permanentlyUnavailable.length) {
      throw new Error(`Topic ${topic.id} can never become available: ${permanentlyUnavailable.join(", ")}.`);
    }
  }
}
