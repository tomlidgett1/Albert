const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

/**
 * Builds the durable lease owner used by a worker process.
 *
 * A configured value identifies the service role. The runtime suffix identifies
 * the concrete replica so two machines can never renew or release one another's
 * leases. Fly supplies FLY_MACHINE_ID automatically; other orchestrators can
 * provide ALBERT_WORKER_INSTANCE_ID explicitly.
 */
export function loadReplicaWorkerId(
  source: NodeJS.ProcessEnv,
  configuredName: string,
  missingMessage: string,
): string {
  const configuredId = source[configuredName]?.trim();
  if (!configuredId) throw new Error(missingMessage);

  const instanceId =
    source.FLY_MACHINE_ID?.trim() || source.ALBERT_WORKER_INSTANCE_ID?.trim();
  if (source.NODE_ENV === "production" && !instanceId) {
    throw new Error(
      `${configuredName} requires FLY_MACHINE_ID or ALBERT_WORKER_INSTANCE_ID in production.`,
    );
  }
  const workerId = instanceId ? `${configuredId}:${instanceId}` : configuredId;

  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new Error(`${configuredName} or its runtime instance identifier is invalid.`);
  }
  return workerId;
}
