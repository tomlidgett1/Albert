import type {
  CanonicalDossierContext,
  CanonicalDossierContributorHook,
  CanonicalDossierFactContribution,
  CanonicalReferenceLookupHook,
} from "../../services/sync-workers/src/canonical-contract.js";

type XeroDossierSourceRow = Readonly<{
  base_currency: string | null;
  sales_tax_basis: string | null;
  tax_number: string | null;
  observed_at: string | Date | null;
}>;

export const xeroReferenceLookup: CanonicalReferenceLookupHook = Object.freeze({
  databaseRegistrationId: "xero.reference-lookup",
  async resolve({ database, job, reference, lookup }) {
    const connectionId = reference.connectionId ?? job.connectionId;
    if (lookup.key !== "gl_account_code" || reference.table !== "gl_account" ||
        connectionId !== job.connectionId) {
      throw new Error("canonical_natural_key_scope_invalid");
    }
    const matched = await database.run<{
      source_record_id: string;
      source_object_type: string;
    }>(
      "reference.natural_key_candidates",
      [job.tenantId, connectionId, lookup.value,job.connectionGeneration],
    );
    if (matched.length === 1) {
      const row = matched[0]!;
      return Object.freeze({
        status: "matched" as const,
        sourceObjectType: row.source_object_type,
        sourceRecordId: row.source_record_id,
      });
    }
    return Object.freeze({ status: matched.length ? "ambiguous" as const : "missing" as const });
  },
});

export const xeroDossierContributor: CanonicalDossierContributorHook = Object.freeze({
  connectorId: "xero",
  databaseRegistrationId: "xero.dossier",
  ownedKeys: Object.freeze(["base_currency","accounting_basis","gst_registration"]),
  async collect({ database, tenantId, connection, context }) {
    const source = await database.run<XeroDossierSourceRow>(
      "dossier.latest_source",
      [tenantId,connection.connectionId,connection.connectionGeneration],
    );
    return buildXeroDossierContributions(source[0], context);
  },
});

/** Pure translation kept beside the source contract for deterministic evidence tests. */
export function buildXeroDossierContributions(
  row: XeroDossierSourceRow | undefined,
  context: CanonicalDossierContext,
): readonly CanonicalDossierFactContribution[] {
  if (!row) return Object.freeze([]);
  const contributions: CanonicalDossierFactContribution[] = [];
  const observedAt = latestTimestamp(context.entityObservedAt, row.observed_at);
  const baseCurrency = (row.base_currency ?? context.baseCurrency)?.trim().toUpperCase() ?? null;
  contributions.push(Object.freeze({
    key: "base_currency",
    value: baseCurrency && /^[A-Z]{3}$/u.test(baseCurrency) ? baseCurrency : null,
    source: "Xero Organisation settings and canonical legal entity",
    observedAt,
    confidence: 1,
    confirmationState: "source_reported",
    merge: "replace",
  }));

  const salesTaxBasis = row.sales_tax_basis?.trim().toUpperCase() ?? "";
  const accountingBasis = salesTaxBasis.includes("CASH")
    ? "Cash"
    : salesTaxBasis.includes("ACCRUAL") ? "Accrual" : null;
  contributions.push(Object.freeze({
    key: "accounting_basis",
    value: accountingBasis,
    source: "Xero Organisation settings",
    observedAt: row.observed_at,
    confidence: 1,
    confirmationState: "source_reported",
    merge: "replace",
  }));

  const gstRegistration = salesTaxBasis === "NONE"
    ? "Not registered"
    : salesTaxBasis || row.tax_number?.trim() ? "Registered" : null;
  contributions.push(Object.freeze({
    key: "gst_registration",
    value: gstRegistration,
    source: "Xero Organisation tax settings",
    observedAt: row.observed_at,
    confidence: salesTaxBasis ? 0.98 : 0.85,
    confirmationState: salesTaxBasis ? "source_reported" : "inferred",
    merge: "replace",
  }));
  return Object.freeze(contributions);
}

function latestTimestamp(...values: readonly (string | Date | null)[]): string | Date | null {
  return values
    .filter((value): value is string | Date => value !== null)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
}
