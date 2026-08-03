import { z } from "zod";

const id = z.string().min(1);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const contactRef = z.object({ ContactID: id.optional(), Name: z.string().optional() }).passthrough();
const lineItems = z.array(z.record(z.string(), z.unknown())).optional();

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

export const xeroSchemas = {
  organisation: xeroOrganisationSchema,
  accounts: xeroAccountSchema,
  contacts: xeroContactSchema,
  invoices: xeroInvoiceSchema,
  credit_notes: xeroCreditNoteSchema,
  payments: xeroPaymentSchema,
  bank_transactions: xeroBankTransactionSchema,
  manual_journals: xeroManualJournalSchema,
  journals: xeroJournalSchema,
  tax_rates: xeroTaxRateSchema,
  tracking_categories: xeroTrackingCategorySchema,
} as const;

export type XeroStreamId = keyof typeof xeroSchemas;
