import { createHash } from "node:crypto";
import type { SpecialistAgentDefinition } from "./registry.js";

/**
 * Immutable receipt for the exact specialist policy used by a turn. The digest
 * is persisted beside the model/runtime profile; it is evidence and cache
 * partitioning metadata, never an authorization token.
 */
export function specialistAgentDefinitionDigest(
  definition: SpecialistAgentDefinition,
): string {
  const canonical = JSON.stringify({
    id: definition.id,
    version: definition.version,
    allowedRoles: definition.allowedRoles,
    primaryViews: definition.primaryViews,
    supportingViews: definition.supportingViews,
    recommendedSkills: definition.recommendedSkills,
    starterPrompts: definition.starterPrompts,
    alwaysRule: definition.alwaysRule ?? null,
    priority: definition.priority,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
