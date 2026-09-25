export {
  FIVETRAN_SERVICES,
  FIVETRAN_SERVICE_IDS,
  FIVETRAN_XERO_DESTINATION_SCHEMA,
  FIVETRAN_XERO_SERVICE,
  fivetranConnectionSchema,
  fivetranDestinationSchema,
  fivetranServiceForConnectorKey,
  fivetranXeroConnectionSchema,
  fivetranXeroDestinationSchema,
  isFivetranDestinationSchema,
  isFivetranService,
  type FivetranConnectorKey,
  type FivetranService,
  type FivetranServiceDefinition,
} from "./schema.js";
export {
  FivetranApiError,
  FivetranClient,
  summarizeSetupTests,
  type FivetranClientConfig,
  type FivetranConnection,
  type FivetranConnectionStatus,
  type FivetranSchemaSummary,
  type FivetranSetupState,
  type FivetranSetupTest,
} from "./client.js";
export {
  exchangeXeroAuthorizationCode,
  listXeroTenants,
  type XeroOAuthTokens,
  type XeroTenantConnection,
} from "./xero-oauth.js";
