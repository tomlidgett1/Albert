import type {
  CanonicalMappingContext,
  CanonicalProjectionCommand,
  CanonicalStagingRow,
} from "../../services/sync-workers/src/canonical-contract.js";

/**
 * meta-ads is an authorization-only pack: it declares no stream, so no staging row
 * can legitimately reach the canonical transform for it. Reaching this mapper
 * means a row was routed to the wrong connector, which must fail loudly rather
 * than project silently into another connector's canonical space.
 */
export function mapMetaAdsCanonical(
  stream: string,
  row: CanonicalStagingRow,
  context: CanonicalMappingContext,
): readonly CanonicalProjectionCommand[] {
  void row; void context;
  throw new Error(
    `meta-ads declares no canonical stream; refusing to map staged rows for ${stream}.`,
  );
}
