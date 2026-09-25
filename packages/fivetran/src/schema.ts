/**
 * Fivetran destination schema names are permanent and must follow Fivetran's
 * naming rules: lowercase letters, digits, and underscores, and they must
 * start with a letter. Names that start with a digit are rejected or rewritten
 * (5XERO would become _5xero). Albert uses Fivetran's native tables for each
 * source, with one destination schema per Albert connection so tenants never
 * share rows: `<prefix>_<connection_ulid>`.
 */
export const FIVETRAN_XERO_DESTINATION_SCHEMA = "xero";
export const FIVETRAN_XERO_SERVICE = "xero";

/**
 * Every Fivetran-managed source Albert offers. `service` is Fivetran's
 * connector id; `connectorKey` is the provider id the dash and control-plane
 * use; `schemaPrefix` is the destination-schema prefix; `authorization` says
 * how the grant happens:
 *  - `connect_card`: only Fivetran's hosted Connect Card can authorise it
 *    (Lightspeed, with Fivetran's own OAuth app).
 *  - `api`: Albert obtains the credential itself and creates the connection
 *    fully via the REST API — no card (Deputy: sub_domain + access token;
 *    Stripe: Restricted / secret key from Albert's Connect grant;
 *    Xero: Albert's SDK connector + token broker).
 */
export const FIVETRAN_SERVICES = Object.freeze({
  // Xero runs on Albert's own Connector SDK connector (connectors/xero-fivetran-sdk):
  // Albert's Xero OAuth takes the single consent, the worker deploys the SDK
  // connection, and the connector fetches short-lived tokens from the worker.
  xero: Object.freeze({
    service: "xero",
    connectorKey: "fivetran-xero",
    displayName: "Xero (Fivetran)",
    schemaPrefix: "xero",
    authorization: "api",
  }),
  // Lightspeed Retail R-Series likewise runs on Albert's own Connector SDK
  // connector (connectors/lightspeed-fivetran-sdk): Albert's Lightspeed OAuth
  // takes the single consent and the connector lands all 90 ls_* tables. The
  // service key is kept for the control-plane CHECK constraint (0149).
  light_speed_retail: Object.freeze({
    service: "light_speed_retail",
    connectorKey: "fivetran-lightspeed",
    displayName: "Lightspeed Retail (Fivetran)",
    schemaPrefix: "lightspeed",
    authorization: "api",
  }),
  deputy: Object.freeze({
    service: "deputy",
    connectorKey: "fivetran-deputy",
    displayName: "Deputy (Fivetran)",
    schemaPrefix: "deputy",
    authorization: "api",
  }),
  // Stripe uses Fivetran's native connector and official ERD table names
  // (charge, invoice, subscription_history, …). Albert takes Stripe Connect
  // OAuth itself, then creates the Fivetran connection with the granted
  // Restricted / secret key. No Stripe Admin API connector and no SDK reshape.
  stripe: Object.freeze({
    service: "stripe",
    connectorKey: "fivetran-stripe",
    displayName: "Stripe (Fivetran)",
    schemaPrefix: "stripe",
    authorization: "api",
  }),
} as const);

export type FivetranService = keyof typeof FIVETRAN_SERVICES;
/** How Fivetran obtains the grant: `api` — Albert holds it and provisions the
 * connection outright; `connect_card` — Fivetran's hosted card takes it. */
export type FivetranAuthorization = "api" | "connect_card";
export type FivetranServiceDefinition = Readonly<{
  service: FivetranService;
  connectorKey: (typeof FIVETRAN_SERVICES)[FivetranService]["connectorKey"];
  displayName: string;
  schemaPrefix: string;
  authorization: FivetranAuthorization;
}>;
export type FivetranConnectorKey = FivetranServiceDefinition["connectorKey"];

export const FIVETRAN_SERVICE_IDS = Object.freeze(
  Object.keys(FIVETRAN_SERVICES) as FivetranService[],
);

export function isFivetranService(value: string): value is FivetranService {
  return Object.prototype.hasOwnProperty.call(FIVETRAN_SERVICES, value);
}

export function fivetranServiceForConnectorKey(connectorKey: string): FivetranServiceDefinition | undefined {
  return Object.values(FIVETRAN_SERVICES).find((definition) => definition.connectorKey === connectorKey);
}

const FIVETRAN_SCHEMA_NAME = /^[a-z][a-z0-9_]{0,127}$/;
const CONNECTION_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isFivetranDestinationSchema(value: string): boolean {
  return FIVETRAN_SCHEMA_NAME.test(value);
}

export function fivetranDestinationSchema(value: string): string {
  const schema = value.trim();
  if (!isFivetranDestinationSchema(schema)) {
    throw new Error("fivetran_schema_invalid");
  }
  return schema;
}

export function fivetranXeroDestinationSchema(value = FIVETRAN_XERO_DESTINATION_SCHEMA): string {
  return fivetranDestinationSchema(value);
}

/** `<prefix>_<connection ulid, lowercased>` — the tenant-isolation primitive. */
export function fivetranConnectionSchema(prefix: string, connectionId: string): string {
  if (!CONNECTION_ULID.test(connectionId)) throw new Error("fivetran_schema_invalid");
  return fivetranDestinationSchema(`${fivetranDestinationSchema(prefix)}_${connectionId.toLowerCase()}`);
}

export function fivetranXeroConnectionSchema(
  connectionId: string,
  prefix = FIVETRAN_XERO_DESTINATION_SCHEMA,
): string {
  return fivetranConnectionSchema(prefix, connectionId);
}
