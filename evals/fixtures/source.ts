import type { SourceField } from "../../services/semantic-query/src/index.js";

export const FIXTURE_LIGHTSPEED_CONNECTION_ID = "01J00000000000000000000011";

export const sourceFixtureCatalogue: readonly SourceField[] = [
  {
    connectionId: FIXTURE_LIGHTSPEED_CONNECTION_ID,
    connectorId: "lightspeed-r",
    sourceSchema: "source_lightspeed",
    sourceTable: "sales",
    sourceField: "discount_reason",
    fieldType: "text",
    piiClass: "business",
    authorityConcept: "operational_sales",
    definition: "The source-recorded R-Series reason associated with a sale discount.",
    packVersion: "1.1.0",
  },
] as const;

export const sourceFixtureRows = [
  {
    connection_id: FIXTURE_LIGHTSPEED_CONNECTION_ID,
    discount_reason: "staff purchase",
  },
  {
    connection_id: FIXTURE_LIGHTSPEED_CONNECTION_ID,
    discount_reason: "staff purchase",
  },
  {
    connection_id: FIXTURE_LIGHTSPEED_CONNECTION_ID,
    discount_reason: "damaged packaging",
  },
] as const;
