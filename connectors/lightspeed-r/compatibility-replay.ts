import {
  type CanonicalCompatibilityReplayHook,
} from "../../services/sync-workers/src/canonical-contract.js";
import { lightspeedRManifest } from "./manifest.js";

const REPLAY_TRIGGER_STREAMS = new Set(["vendors", "orders"]);
const LEGACY_LIGHTSPEED_REPLAY_CANDIDATE_LIMIT = 100;
const LEGACY_LIGHTSPEED_REPLAY_COMMAND_LIMIT = 500;

const noReplay = Object.freeze({
  eligible: false,
  candidates: Object.freeze([]),
});

/**
 * Pack 1.0 Orders that failed solely because Vendor did not exist cannot be
 * claimed again after OAuth re-consent fences their old transform generation.
 * Pack 1.1 therefore owns one bounded compatibility lane. The database opens
 * it only after current-generation Vendor and Order backfill plus deletion
 * reconciliation are complete, and returns exact immutable pack-1.0 lineage.
 */
export const lightspeedRCompatibilityReplay: CanonicalCompatibilityReplayHook = Object.freeze({
  databaseRegistrationId: "lightspeed-r.compatibility-replay",
  sourceStream: "orders",
  candidateLimit: LEGACY_LIGHTSPEED_REPLAY_CANDIDATE_LIMIT,
  commandLimit: LEGACY_LIGHTSPEED_REPLAY_COMMAND_LIMIT,
  handles(job, stream) {
    return job.connectorId === lightspeedRManifest.id && REPLAY_TRIGGER_STREAMS.has(stream);
  },

  async selectChunk(input) {
    const { database, job } = input;
    const eligibility = await database.run<{ connection_generation: number | string | null }>(
      "compatibility.replay_generation",
      [job.tenantId, job.connectionId, job.batchId,job.connectionGeneration],
    );
    const generation = eligibility[0]?.connection_generation;
    if (generation === null || generation === undefined) return noReplay;
    const parsedGeneration = Number(generation);
    if (!Number.isSafeInteger(parsedGeneration) || parsedGeneration < 1) {
      throw new Error("canonical_dependency_replay_generation_invalid");
    }
    if(parsedGeneration!==job.connectionGeneration){
      throw new Error("canonical_dependency_replay_generation_stale");
    }

    const candidates = await database.replayCandidates(
      "compatibility.replay_candidates",
      [job.tenantId, job.connectionId, job.mappingVersion, job.connectionGeneration,
        LEGACY_LIGHTSPEED_REPLAY_CANDIDATE_LIMIT,lightspeedRManifest.apiVersion],
    );
    return Object.freeze({
      eligible: true,
      candidates,
    });
  },
});
