/**
 * Reproducible source lock for the Square read contract.
 *
 * Square does not currently publish a downloadable OpenAPI artifact from the
 * developer documentation site.  The official Node SDK is generated from
 * Square's API definition, pins the same dated API version in every request,
 * and exposes the wire-format `Raw` declarations used by the field census.
 */
export const SQUARE_CONTRACT_LOCK = Object.freeze({
  apiVersion: "2026-07-15",
  sdk: Object.freeze({
    package: "square",
    version: "45.0.1",
    npmSpecifier: "square@45.0.1",
    npmIntegrity:
      "sha512-o/pee+2jzAXnAecjUftY78oYIEJDyrvqq9FsJNszkX68ZGvn+JUldLBEqT6+a8f3L9HLhqyq8n8s0M7pctbTog==",
    tarballSha256: "a6d08493df4a40ecc685272194eed11cd03d69c7fad54e37d858993a044d1406",
    rawDeclarationGlob: "package/serialization/types/*.d.ts",
  }),
  documentationRetrievedAt: "2026-08-12",
  sources: Object.freeze({
    apiReference: "https://developer.squareup.com/reference/square",
    objects: "https://developer.squareup.com/reference/square/objects",
    enums: "https://developer.squareup.com/reference/square/enums",
    permissions: "https://developer.squareup.com/docs/oauth-api/square-permissions",
    pagination:
      "https://developer.squareup.com/docs/build-basics/common-api-patterns/pagination",
    versioning:
      "https://developer.squareup.com/docs/build-basics/versioning-overview",
    lifecycle: "https://developer.squareup.com/docs/build-basics/api-lifecycle",
    errors:
      "https://developer.squareup.com/docs/build-basics/general-considerations/handling-errors",
    webhooks: "https://developer.squareup.com/docs/webhooks/overview",
    webhookValidation: "https://developer.squareup.com/docs/webhooks/step3validate",
    events: "https://developer.squareup.com/docs/events-api/overview",
    money:
      "https://developer.squareup.com/docs/build-basics/common-data-types/working-with-monetary-amounts",
    dates:
      "https://developer.squareup.com/docs/build-basics/common-data-types/working-with-dates",
    sdkGeneration: "https://developer.squareup.com/blog/how-square-makes-its-sdks/",
  }),
  invariants: Object.freeze({
    cursorTtlSeconds: 300,
    cursorIsDurableWatermark: false,
    unknownFieldsAreNonBreaking: true,
    unknownEnumValuesAreNonBreaking: true,
    rawPayloadRequired: true,
  }),
} as const);

export type SquareContractLock = typeof SQUARE_CONTRACT_LOCK;
