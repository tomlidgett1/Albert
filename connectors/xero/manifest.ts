import { type ConnectorManifest } from "../../packages/connector-sdk/src/index.js";
import { XERO_ACCOUNTING_OPENAPI_REVISION } from "./documented-fields.js";
import { XERO_FIELD_COVERAGE } from "./field-coverage.js";
import { XERO_SPEC_TABLES } from "./scan-plan.js";
import { XERO_STREAMS } from "./streams.js";

/**
 * Every read scope the Xero app is entitled to, requested up front so widening
 * ingestion later never forces customers back through a re-consent. Verified
 * against the live authorize endpoint on 2026-08-06: Xero accepts this exact
 * set and refuses `accounting.transactions[.read]`, `bankfeeds` and `finance.*`
 * for granular-scope apps. No write scope is listed; the pack contains no
 * source write method, so a write grant could only ever exceed what the code
 * can use.
 */
export const XERO_DEFAULT_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
  "accounting.budgets.read",
  "accounting.attachments.read",
  "accounting.reports.tenninetynine.read",
  "payroll.employees.read",
  "payroll.payruns.read",
  "payroll.payslip.read",
  "payroll.timesheets.read",
  "payroll.settings.read",
  "files.read",
  "assets.read",
  "projects.read",
] as const;

/**
 * Approval-gated at the vendor, not by Albert. The live authorize endpoint
 * refuses `accounting.journals.read` until Xero grants Advanced-tier use-case
 * approval, so it stays behind XERO_ENABLE_ADVANCED_JOURNALS rather than
 * breaking every authorization for apps that do not have it.
 * `accounting.reports.read` is refused on the same basis and is omitted
 * entirely until that approval exists.
 */
export const XERO_ADVANCED_SCOPES = ["accounting.journals.read"] as const;
export const XERO_ALLOWED_SCOPES = [...XERO_DEFAULT_SCOPES, ...XERO_ADVANCED_SCOPES] as const;

export function xeroRequestedScopes(includeAdvancedJournals: boolean): readonly string[] {
  return includeAdvancedJournals ? XERO_ALLOWED_SCOPES : XERO_DEFAULT_SCOPES;
}

export const xeroManifest: ConnectorManifest = {
  id: "xero",
  displayName: "Xero Accounting",
  packVersion: "2.0.0",
  apiVersion: `Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI ${XERO_ACCOUNTING_OPENAPI_REVISION}; granular OAuth scopes (March 2026); ${XERO_SPEC_TABLES.length}-table semantic spec`,
  releasedAt: "2026-08-06",
  documentation: [
    "https://developer.xero.com/documentation/guides/oauth2/pkce-flow",
    "https://developer.xero.com/documentation/guides/oauth2/scopes/",
    "https://developer.xero.com/documentation/guides/oauth2/token-types",
    "https://developer.xero.com/documentation/guides/oauth2/limits/",
    "https://developer.xero.com/documentation/best-practices/api-call-efficiencies/paging",
    "https://developer.xero.com/documentation/guides/webhooks/overview/",
    "https://developer.xero.com/changelog",
    "https://xeroapi.github.io/xero-node/accounting/index.html",
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero_accounting.yaml`,
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero_assets.yaml`,
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero-projects.yaml`,
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero_files.yaml`,
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero-payroll-au.yaml`,
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero-payroll-uk.yaml`,
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero-payroll-nz.yaml`,
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero-identity.yaml`,
  ],
  // Manual-only by product decision: ingestion starts from the Connections
  // workspace button, never automatically on connect. The control-plane
  // schedulers and the webhook router exclude xero on the same basis
  // (control-plane migration 0142).
  ingestion: { initialStart: "manual" },
  oauth: {
    scopes: XERO_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "Albert requests every read scope the Xero app is entitled to. The full spec surface behind those scopes — accounting, budgets, attachments, 1099 reports, payroll (AU/UK/NZ), files, assets and projects — is declared as streams, so the grant and the extraction surface now match; it stays strictly read-only because the pack contains no source write method.",
      "openid, profile and email identify the authorising user only. Albert stores no Xero profile record from them and they carry no accounting-data access.",
    ],
    refreshTokenRotation: true,
    remoteRevocation: "supported",
  },
  streams: XERO_STREAMS,
  sourceAuthority: {
    defaults: [{
      concepts: ["statutory_finance", "cash_settlement", "worked_hours"],
      scope: { kind: "canonical_dimension", table: "legal_entity", scopeType: "legal_entity" },
    }],
  },
  rateLimit: {
    algorithm: "per-organisation concurrent, minute, daily and app-minute budgets",
    concurrency: 5,
    budgets: {
      callsPerMinutePerOrganisation: 60,
      starterCallsPerDayPerOrganisation: 1000,
      higherTierCallsPerDayPerOrganisation: 5000,
      pageSize: 1000,
    },
    responseHeaders: [
      "X-MinLimit-Remaining",
      "X-DayLimit-Remaining",
      "X-AppMinLimit-Remaining",
      "Retry-After",
    ],
    reservations: [
      {
        key: "xero.api-minute",
        burstCapacity: 5,
        interval: { kind: "fixed", milliseconds: 1_000 },
      },
      {
        key: "xero.api-day",
        burstCapacity: 60,
        interval: {
          kind: "window_budget",
          windowMilliseconds: 86_400_000,
          option: "dailyRequestLimit",
          defaultLimit: 1_000,
          allowedLimits: [1_000, 5_000],
        },
      },
    ],
  },
  capabilities: {
    "finance.settings": {
      support: "full", streams: ["xero_organisations", "xero_accounts", "xero_tax_rates"],
      reason: "Organisation, Accounts and TaxRates provide the accounting configuration used by the dossier and semantic model.",
    },
    "finance.invoices": {
      support: "full", streams: ["xero_invoices", "xero_credit_notes"],
      reason: "Invoices and CreditNotes map to canonical finance invoice lines.",
    },
    "finance.payments": {
      support: "full", streams: ["xero_payments"],
      reason: "Payments provide source-native settlement allocation evidence.",
    },
    "finance.bank_transactions": {
      support: "full", streams: ["xero_bank_transactions"],
      reason: "BankTransactions map to canonical bank transaction facts.",
    },
    "finance.journals": {
      support: "unknown", streams: ["xero_journals"],
      reason: "Posted Journals require the Advanced accounting.journals.read grant and a successful live endpoint probe.",
    },
    "finance.journals.tax": {
      support: "unknown", streams: ["xero_journals"], coverageFields: ["JournalLines"],
      reason: "Journal tax analysis is confirmed with the Advanced Journals stream and its line tax fields.",
    },
    "source.webhooks.contacts": {
      support: "full", streams: [],
      reason: "Xero documents Contacts webhook events.",
    },
    "source.webhooks.invoices": {
      support: "full", streams: [],
      reason: "Xero documents Invoices webhook events.",
    },
    "source.webhooks.credit_notes": {
      support: "full", streams: [],
      reason: "Xero documents Credit Notes webhook events.",
    },
  },
  identityRules: [
    "Contact email is a deterministic cross-source suggestion only; an owner confirms ambiguous customer matches.",
    "Contact TaxNumber/ABN may deterministically link suppliers within the tenant when present and exact.",
    "Tracking categories are source-native dimensions until explicitly mapped by a tenant overlay.",
    "Payroll employees are region-scoped identities; they never merge across payroll regions because a tenant has exactly one payroll region.",
  ],
  topology: [
    "Journals are authoritative statutory ledger observations, including POS summary journals.",
    "BankTransactions and Payments ground cash settlement and reconciliation independently of POS tenders.",
    "Invoices and CreditNotes map into one source-neutral finance invoice-line domain with reversal semantics.",
    "Payroll pay runs, payslips and their typed line families are statutory payroll records; timesheets and leave are worked-hours observations.",
    "Attachments and history records are budget-priced fan-out evidence attached to their parent documents.",
  ],
  fieldCoverage: XERO_FIELD_COVERAGE,
  qualityAssertions: [
    "cursor_completeness",
    "scope_available",
    "retention_limit_recorded",
    "webhook_gap_recovered",
    "delete_handling",
    "schema_drift",
    "enum_drift",
    "journal_balances_source",
    "invoice_totals_source",
  ],
  limitations: [
    "The Journals endpoint and accounting.journals.read scope require an Advanced-tier app, initial and annual security assessment, and use-case approval. Albert omits that scope unless XERO_ENABLE_ADVANCED_JOURNALS=true; ledger-backed answers remain Unavailable until approval and a live endpoint probe both succeed.",
    "Rendered report endpoints (P&L, Balance Sheet, Trial Balance, aged summaries) sit behind accounting.reports.read, which Xero refuses for granular-scope apps; the same numbers resolve from the journals and account tables instead. The granted TenNinetyNine report is the only report surface ingested.",
    "Payroll is region-exclusive: AU, UK and NZ streams are gated on the organisation's region and the other regions report capability_unavailable rather than staging empty tables.",
    "Attachment and history fan-out streams are budget-priced against Xero's 60/minute and 1,000-5,000/day org limits; they are declared optional and fill opportunistically after core backfill.",
    "Daily request allowance is tier dependent (1,000 Starter; 5,000 higher tiers), so the worker records response budgets and replays immutable raw data instead of re-pulling.",
    "Webhooks accelerate Contacts, Invoices and Credit Notes only; all streams continue to poll and reconcile.",
    "Xero API data must never be used to train AI models. Albert applies its platform-wide no-training policy to all providers.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
