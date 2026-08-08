/**
 * Zod schemas for every Xero spec stream, generated from the table spec so the
 * schema record and the manifest stream set can never drift. Each generated
 * schema types the PROJECTED row — the flattened fields the staging contract
 * stages — not the vendor envelope: numeric columns accept Xero's
 * string-or-number decimals, timestamp columns accept ISO strings (the
 * projection normalizes `/Date(ms)/` first), and enum vocabularies stay open
 * strings because a vendor-added value is enum drift to report, not a page to
 * reject.
 *
 * The founding accounting resources additionally keep their strict envelope
 * validators (below), applied by the sync engine to raw vendor records before
 * projection, preserving the original pack's identity requirements.
 */
import { z } from "zod";
import { XERO_SPEC_TABLES, xeroSourceField, type XeroSpecTable } from "./scan-plan.js";

const id = z.string().min(1);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const contactRef = z.object({ ContactID: id.optional(), Name: z.string().optional() }).passthrough();
const lineItems = z.array(z.record(z.string(), z.unknown())).optional();

function columnSchema(type: string): z.ZodTypeAny {
  switch (type) {
    case "numeric":
    case "integer":
    case "bigint":
    case "real":
      return z.union([z.number(), z.string()]).nullish();
    case "boolean":
      return z.boolean().nullish();
    case "timestamp":
    case "date":
      return z.string().nullish();
    case "jsonb":
      return z.unknown().nullish();
    default:
      return z.union([z.string(), z.number()]).nullish();
  }
}

function streamSchema(table: XeroSpecTable): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const column of table.columns) {
    shape[xeroSourceField(column)] = columnSchema(column.type);
  }
  return z.object(shape).passthrough();
}

/** One schema per spec stream, keyed by stream id — the contract-test surface. */
export const xeroSchemas: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze(
  Object.fromEntries(XERO_SPEC_TABLES.map((table) => [table.id, streamSchema(table)])),
);

export type XeroStreamId = string;

/* ------------------------------------------------------------------ */
/* Envelope validators for the founding accounting resources, applied  */
/* to raw vendor records before projection. A record failing identity  */
/* or correctness-critical parsing is quarantined as schema_invalid.   */
/* ------------------------------------------------------------------ */

export const xeroOrganisationSchema = z.object({
  OrganisationID: id,
  Name: z.string(),
  BaseCurrency: z.string().length(3).optional(),
  SalesTaxBasis: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
}).passthrough();

export const xeroAccountSchema = z.object({
  AccountID: id,
  Code: z.string().optional(),
  Name: z.string(),
  Type: z.string().optional(),
  Status: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
}).passthrough();

export const xeroContactSchema = z.object({
  ContactID: id,
  Name: z.string().optional(),
  ContactStatus: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
}).passthrough();

export const xeroInvoiceSchema = z.object({
  InvoiceID: id,
  Type: z.string(),
  Contact: contactRef.optional(),
  Date: scalar.optional(),
  Status: z.string().optional(),
  Total: scalar.optional(),
  CurrencyCode: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
  LineItems: lineItems,
}).passthrough();

export const xeroCreditNoteSchema = z.object({
  CreditNoteID: id,
  Type: z.string(),
  Contact: contactRef.optional(),
  Date: scalar.optional(),
  Status: z.string().optional(),
  Total: scalar.optional(),
  CurrencyCode: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
  LineItems: lineItems,
}).passthrough();

export const xeroPaymentSchema = z.object({
  PaymentID: id,
  Date: scalar.optional(),
  Amount: scalar.optional(),
  BankAmount: scalar.optional(),
  Status: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
  Invoice: z.unknown().optional(),
  CreditNote: z.unknown().optional(),
  Prepayment: z.unknown().optional(),
  Overpayment: z.unknown().optional(),
  Account: z.unknown().optional(),
  BatchPaymentID: id.optional(),
  BatchPayment: z.unknown().optional(),
}).passthrough();

export const xeroBankTransactionSchema = z.object({
  BankTransactionID: id,
  Type: z.enum([
    "RECEIVE","RECEIVE-OVERPAYMENT","RECEIVE-PREPAYMENT","RECEIVE-TRANSFER",
    "SPEND","SPEND-OVERPAYMENT","SPEND-PREPAYMENT","SPEND-TRANSFER",
  ]),
  Date: scalar.optional(),
  Status: z.string().optional(),
  Total: scalar.optional(),
  CurrencyCode: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
  LineItems: lineItems,
}).passthrough();

export const xeroManualJournalSchema = z.object({
  ManualJournalID: id,
  Date: scalar.optional(),
  Status: z.string().optional(),
  JournalLines: z.array(z.record(z.string(), z.unknown())).optional(),
  UpdatedDateUTC: scalar.optional(),
}).passthrough();

export const xeroJournalSchema = z.object({
  JournalID: id,
  JournalNumber: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  JournalDate: scalar.optional(),
  CreatedDateUTC: scalar.optional(),
  JournalLines: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough();

export const xeroTaxRateSchema = z.object({
  TaxType: z.string().min(1),
  Name: z.string(),
  Status: z.string().optional(),
  DisplayTaxRate: scalar.optional(),
  EffectiveRate: scalar.optional(),
}).passthrough();

export const xeroTrackingCategorySchema = z.object({
  TrackingCategoryID: id,
  Name: z.string(),
  Status: z.string().optional(),
  UpdatedDateUTC: scalar.optional(),
}).passthrough();

/** Envelope validators keyed by the walked accounting resource. */
export const xeroEnvelopeSchemas: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
  Organisations: xeroOrganisationSchema,
  Accounts: xeroAccountSchema,
  Contacts: xeroContactSchema,
  Invoices: xeroInvoiceSchema,
  CreditNotes: xeroCreditNoteSchema,
  Payments: xeroPaymentSchema,
  BankTransactions: xeroBankTransactionSchema,
  ManualJournals: xeroManualJournalSchema,
  Journals: xeroJournalSchema,
  TaxRates: xeroTaxRateSchema,
  TrackingCategories: xeroTrackingCategorySchema,
});
