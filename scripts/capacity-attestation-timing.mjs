export const CAPACITY_ATTESTATION_SAMPLE_INTERVAL_MS = 15_000;
export const CAPACITY_ATTESTATION_MAX_OBSERVATION_MS = 47 * 60_000;
export const CAPACITY_ATTESTATION_LEASE_SECONDS = 120;
export const CAPACITY_ATTESTATION_POLL_AFTER_SECONDS = 15;
export const CAPACITY_ATTESTATION_POLL_WINDOW_MS = 53 * 60_000;
export const CAPACITY_ATTESTATION_DEPLOYMENT_ALLOWANCE_MS = 30 * 60_000;
export const CAPACITY_ATTESTATION_HARNESS_HOLD_MS = 85 * 60_000;
export const CAPACITY_ATTESTATION_JOB_TIMEOUT_MS = 90 * 60_000;

// A crashed collector must lose its renewable lease early enough for another
// attestor instance to resume the durable checkpoint and finish inside the
// original protected workflow attempt. Keep an explicit allowance for OIDC,
// request, final observation, signing, and the next polling interval.
export const CAPACITY_ATTESTATION_RECOVERY_ALLOWANCE_MS = 3 * 60_000;

if (
  CAPACITY_ATTESTATION_POLL_WINDOW_MS <
  CAPACITY_ATTESTATION_MAX_OBSERVATION_MS +
    CAPACITY_ATTESTATION_LEASE_SECONDS * 1_000 +
    CAPACITY_ATTESTATION_RECOVERY_ALLOWANCE_MS
) {
  throw new Error("Capacity attestation polling window cannot accommodate lease takeover.");
}

if (
  CAPACITY_ATTESTATION_HARNESS_HOLD_MS <
  CAPACITY_ATTESTATION_DEPLOYMENT_ALLOWANCE_MS + CAPACITY_ATTESTATION_POLL_WINDOW_MS ||
  CAPACITY_ATTESTATION_HARNESS_HOLD_MS >= CAPACITY_ATTESTATION_JOB_TIMEOUT_MS
) {
  throw new Error("Capacity harness hold does not fit the protected release job timing.");
}
