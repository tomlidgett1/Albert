/**
 * Reproducible lock for the official Lightspeed Retail X-Series contract.
 *
 * Lightspeed publishes both a bulk OpenAPI document and one operation fragment
 * per indexed reference page. The census generator follows the official
 * `llms.txt` index and merges all 196 fragments deterministically. The bulk
 * contract independently supplies inline response shapes that are not named
 * components in those fragments; generation locks both representations.
 */
export const LIGHTSPEED_X_CONTRACT_LOCK = Object.freeze({
  apiVersion: "2026-07",
  serverTemplate: "https://{domain_prefix}.retail.lightspeed.app/api/2026-07",
  retrievedAt: "2026-08-12",
  officialIndex: Object.freeze({
    url: "https://x-series-api.lightspeedhq.com/llms.txt",
    sha256: "b2b10867c8ad96aefb1d10edbfc07d8e8ad2c54825f1a88233b19babb6b694e4",
  }),
  officialBulkOpenApi: Object.freeze({
    url: "https://x-series-api.lightspeedhq.com/openapi/api-2026-07.yaml",
    sha256:
      "123b2630178c376990dd7219f92e068e5f77ac9cd991a80e0fafa97ad8613dd7",
    pathCount: 130,
    operationCount: 196,
    schemaCount: 356,
    responseReachableSchemaCount: 220,
    scheduledResponseFieldCount: 1_323,
    endpointDifferenceFromPageMerge: 0,
    responseReadablePropertyDifferenceFromPageMerge: 0,
  }),
  mergedOpenApi: Object.freeze({
    sha256: "51170855ec69622e0fb1556cfd1af1144e8ab720455c75b88b01d8d465899865",
    referencePageManifestSha256:
      "39a254a4c51bd8c9dbc015868fb84886e499e36ab197bcb72dfe75bba9754fdf",
    pathCount: 130,
    operationCount: 196,
    schemaCount: 308,
    directFieldCount: 1_633,
    expandedFieldCount: 5_202,
    pathCollisionCount: 0,
    componentCollisionCount: 0,
  }),
  artifactHashes: Object.freeze({
    operations: "bc5309c8eea1652c7e0e42e2aebc6b8c74ffb27da139201219abf40ec2d41d2c",
    pagination: "e43d5d8509833925ba85e9d72265a4164937c76a70c030758987cf65df8657e9",
    readStreams: "69e0ca4080a26306c79cbd2adc2153185dc66aacc05902345b68662f506fe5ad",
    directFields: "bf9932e465f5cd3d4d9702b8bc050af96602f84a77db4e2c7ad7a273068ce116",
    expandedFields: "c957bc24eee239bae6f38b5572df5f6f9ddae5ce5ffcbe2f26eaffa3f1c51aab",
    opaqueGaps: "87792533cb36fb54038d1a5ce843a6addea7f7734ce55824d1500d70b90d94b1",
  }),
  documentation: Object.freeze({
    hub: "https://x-series-api.lightspeedhq.com/",
    authorization: "https://x-series-api.lightspeedhq.com/docs/authorization",
    scopes: "https://x-series-api.lightspeedhq.com/docs/scopes",
    pagination: "https://x-series-api.lightspeedhq.com/docs/pagination",
    rateLimiting: "https://x-series-api.lightspeedhq.com/docs/rate_limiting",
    dates: "https://x-series-api.lightspeedhq.com/docs/dates_and_times",
    versioning: "https://x-series-api.lightspeedhq.com/docs/versioning-strategy",
    webhooks: "https://x-series-api.lightspeedhq.com/docs/webhooks",
    releaseNotes: "https://x-series-api.lightspeedhq.com/docs/2026-07-release-notes",
    openApi: "https://x-series-api.lightspeedhq.com/openapi/api-2026-07.yaml",
  }),
  invariants: Object.freeze({
    versionCursorIsInt64String: true,
    versionCursorIsGlobalAndNonContiguous: true,
    versionCursorTerminatesOnlyOnEmptyData: true,
    rotatingRefreshTokensRequireSerializedCas: true,
    rawPayloadRequired: true,
    pollingIsAuthoritative: true,
    defaultFiveMinuteBudgetForOneRegister: 350,
  }),
} as const);

export type LightspeedXContractLock = typeof LIGHTSPEED_X_CONTRACT_LOCK;
