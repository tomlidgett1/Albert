declare const __ALBERT_SERVICE_BUILD_SHA__: string | undefined;

const FULL_GIT_SHA = /^[a-f0-9]{40}$/u;

/**
 * Replaced with a literal by the service build. The guarded fallback keeps
 * source-level development and unit tests usable without creating a runtime
 * environment-variable seam in production bundles.
 */
export const EMBEDDED_SERVICE_BUILD_SHA =
  typeof __ALBERT_SERVICE_BUILD_SHA__ === "string"
    ? __ALBERT_SERVICE_BUILD_SHA__
    : "development";

/**
 * Fail closed before a production service opens a listener if a mutable
 * runtime label does not match the code identity embedded in its OCI image.
 */
export function assertEmbeddedServiceBuildIdentity(
  source: NodeJS.ProcessEnv,
  embeddedBuildSha: string = EMBEDDED_SERVICE_BUILD_SHA,
): string {
  const embedded = embeddedBuildSha.trim();
  if (source.NODE_ENV !== "production") {
    return FULL_GIT_SHA.test(embedded) ? embedded : "development";
  }

  if (!FULL_GIT_SHA.test(embedded)) {
    throw new Error("The service image does not contain a valid embedded release Git SHA.");
  }
  const runtime = source.ALBERT_SERVICE_VERSION?.trim() ?? "";
  if (!FULL_GIT_SHA.test(runtime)) {
    throw new Error("ALBERT_SERVICE_VERSION must be the full lowercase release Git SHA.");
  }
  if (runtime !== embedded) {
    throw new Error("ALBERT_SERVICE_VERSION does not match the service image build identity.");
  }
  return embedded;
}
