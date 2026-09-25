/**
 * Reproducible lock for the official Momence Public API v2 OpenAPI document.
 *
 * The digest is over the exact response bytes from `sourceUrl`. Updating this
 * lock is a deliberate contract-review action: regenerate the coverage, review
 * the diff, then update the digest/counts together.
 */
export const MOMENCE_OPENAPI_SPEC_LOCK = Object.freeze({
  sourceUrl: "https://static.momence.com/schema/api-v2-schema.yaml",
  documentationUrl: "https://api.docs.momence.com/reference",
  documentationIndexUrl: "https://api.docs.momence.com/llms.txt",
  documentationRetrievedAt: "2026-08-12",
  openapiVersion: "3.0.0",
  apiTitle: "Momence Public",
  apiVersion: "2.0",
  productionServerUrl: "https://api.momence.com",
  sourceByteLength: 329_817,
  sourceSha256: "f290ea3b6632f2428eee22b5220ede3f5e1e5cd6a1a83c6d683a1e206a675a4a",
  expected: Object.freeze({
    paths: 60,
    operations: 74,
    componentSchemas: 200,
    reachableSchemas: 200,
    componentProperties: 1_465,
    operationLeafFields: 2_225,
    requestLeafFields: 404,
    responseLeafFields: 1_821,
    readableLeafFields: 1_821,
    entityValidationContracts: 17,
    operationKeySha256: "349c6757d731515a24a1f56e94d985982bfc60e37226a12f01aecc81ec4a9fb9",
    leafInventorySha256: "d55e5255fc948344c0ef3ed978ee38c51b9da4783f1f81fd5ce45aa6e32e400b",
    reachablePropertySha256: "9aa7fe0c0bd6aec77090f188430606611bb57686db79d362f98201ce03f251b8",
    entityValidationContractSha256: "4f7eb9e051912f3c67f105561a85acc7f1c7d73690754f1c469c2684f1015a16",
  }),
} as const);

export type MomenceOpenApiSpecLock = typeof MOMENCE_OPENAPI_SPEC_LOCK;
