const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{16,}$/u;
const PROJECT_ID = /^prj_[A-Za-z0-9]{16,}$/u;

export type WebReleaseIdentity = Readonly<{
  releaseSha: string;
  deploymentId: string;
  projectId: string | null;
  source: "vercel" | "declared" | "missing";
}>;

/**
 * Vercel supplies immutable Git and deployment identities at build and runtime.
 * Prefer those values whenever the process is running on Vercel so a mutable
 * project environment variable cannot relabel an older deployment.
 */
export function resolveWebReleaseIdentity(
  source: Readonly<Record<string, string | undefined>> = process.env,
): WebReleaseIdentity {
  const vercel = source.VERCEL?.trim() === "1";
  if (vercel) {
    const releaseSha = source.VERCEL_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
    const deploymentId = source.VERCEL_DEPLOYMENT_ID?.trim() ?? "";
    const projectId = source.VERCEL_PROJECT_ID?.trim() ?? "";
    return Object.freeze({
      releaseSha: COMMIT_SHA.test(releaseSha) ? releaseSha : "",
      deploymentId: DEPLOYMENT_ID.test(deploymentId) ? deploymentId : "",
      projectId: PROJECT_ID.test(projectId) ? projectId : null,
      source: "vercel",
    });
  }

  const releaseSha = (
    source.ALBERT_SERVICE_VERSION?.trim() ||
    source.ALBERT_RELEASE_SHA?.trim() ||
    ""
  ).toLowerCase();
  const deploymentId = source.ALBERT_DEPLOYMENT_ID?.trim() ?? "";
  return Object.freeze({
    releaseSha: COMMIT_SHA.test(releaseSha) ? releaseSha : "",
    deploymentId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(deploymentId)
      ? deploymentId
      : "",
    projectId: null,
    source: releaseSha || deploymentId ? "declared" : "missing",
  });
}

/** Preserve the existing configuration API while supplying trusted Vercel IDs. */
export function withWebReleaseIdentity(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  const identity = resolveWebReleaseIdentity(source);
  if (identity.source !== "vercel") return source;
  return Object.freeze({
    ...source,
    ALBERT_SERVICE_VERSION: identity.releaseSha,
    ALBERT_DEPLOYMENT_ID: identity.deploymentId,
    ALBERT_RELEASE_SHA: identity.releaseSha,
  });
}
