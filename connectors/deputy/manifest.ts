import {
  inferStagingType,
  stagingColumnName,
  type ConnectorManifest,
  type FieldCoverage,
} from "../../packages/connector-sdk/src/index.js";

export const DEPUTY_DEFAULT_SCOPES = ["longlife_refresh_token"] as const;

/** Top-level fields reviewed against the pinned Deputy Resource/INFO pages. */
export const DEPUTY_REVIEWED_UNSUPPORTED_FIELDS = Object.freeze({
  companies: ["Creator"],
  operational_units: ["Parent", "Creator", "RosterActiveHoursSchedule", "DailyRosterBudget"],
  employees: ["Saluation", "Salutation", "MainAddress", "PostalAddress", "EmergencyAddress", "DateOfBirth", "Gender", "Pronouns", "CustomPronouns", "Photo", "StressProfile", "TrainingRecords", "AllowAppraisal", "HistoryId", "Creator"],
  rosters: ["Warning", "WarningOverrideComment", "CustomFieldData", "ApprovalRequired", "ConfirmStatus", "ConfirmComment", "ConfirmBy", "ConfirmTime", "SwapStatus", "SwapManageBy", "ConnectStatus", "Creator"],
  timesheets: ["EmployeeHistory", "EmployeeAgreement", "TotalTimeInv", "SupervisorComment", "Supervisor", "Disputed", "TimeApprover", "ValidationFlag", "isInProgress", "LeaveId", "LeaveRule", "Invoiced", "InvoiceComment", "StagingId", "PayStaged", "PayCycleId", "File", "CustomFieldDate", "RealTime", "AutoProcessed", "AutoRounded", "AutoPayRuleApproved", "Creator"],
  contacts: ["Fax", "Phone1Type", "Phone2Type", "Phone3Type", "Email1Type", "Email2Type", "Im1", "Im2", "Im1Type", "Im2Type", "Web", "Saved", "Creator"],
} as const);

const coverage = (
  stream: string,
  canonical: Readonly<Record<string, string>>,
  extensions: readonly string[] = [],
  pii: Readonly<Record<string, FieldCoverage["pii"]>> = {},
): readonly FieldCoverage[] => [
  ...Object.entries(canonical).map(([field, target]) => ({
    stream,
    field,
    disposition: "canonical" as const,
    stagingType: inferStagingType("deputy", field, target),
    target,
    pii: pii[field] ?? ("none" as const),
  })),
  ...extensions.map((field) => ({
    stream,
    field,
    disposition: "governed_extension" as const,
    stagingType: inferStagingType("deputy", field),
    target: `source_deputy.${stream}.${stagingColumnName(field)}`,
    pii: pii[field] ?? ("none" as const),
  })),
];

const unsupportedCoverage = (
  stream: string,
  fields: readonly string[],
  reason: string,
  pii: Readonly<Record<string, FieldCoverage["pii"]>> = {},
): readonly FieldCoverage[] => fields.map((field) => ({
  stream,
  field,
  disposition: "unsupported" as const,
  stagingType: inferStagingType("deputy", field),
  reason,
  pii: pii[field] ?? ("none" as const),
}));

export const deputyManifest: ConnectorManifest = {
  id: "deputy",
  displayName: "Deputy",
  packVersion: "1.0.0",
  apiVersion: "Public API /api/v1 Resource API",
  releasedAt: "2026-08-03",
  documentation: [
    "https://developer.deputy.com/docs/using-oauth-20",
    "https://developer.deputy.com/docs/resource-api-objects",
    "https://developer.deputy.com/docs/getting-data-resources-api",
    "https://developer.deputy.com/docs/webhook-overview",
    "https://developer.deputy.com/docs/webhook-action-list",
    "https://developer.deputy.com/docs/manually-adding-webhooks-to-a-deputy",
    "https://developer.deputy.com/docs/aws-sqs",
    "https://developer.deputy.com/docs/employee",
    "https://developer.deputy.com/docs/roster",
    "https://developer.deputy.com/docs/timesheet",
    "https://developer.deputy.com/docs/leave",
    "https://developer.deputy.com/docs/operational-unit-1",
    "https://developer.deputy.com/docs/company",
    "https://developer.deputy.com/docs/contact",
    "https://developer.deputy.com/docs/address",
  ],
  oauth: {
    scopes: DEPUTY_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "Deputy documents longlife_refresh_token as the OAuth scope rather than resource-specific read scopes. Albert's connector permits only /me reads and Resource endpoints ending in /QUERY.",
    ],
    refreshTokenRotation: true,
    remoteRevocation: "not_documented",
  },
  streams: [
    { id: "companies", resource: "Company", endpoint: "Company/QUERY", recordIdField: "Id", modifiedField: "Modified", queryJoins: ["AddressObject"], pagination: "resource_id_keyset", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["workforce"], canonicalTargets: ["location"] },
    { id: "operational_units", resource: "OperationalUnit", endpoint: "OperationalUnit/QUERY", recordIdField: "Id", modifiedField: "Modified", queryJoins: ["AddressObject"], pagination: "resource_id_keyset", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["companies"], productDomains: ["workforce"], canonicalTargets: ["location"] },
    { id: "employees", resource: "Employee", endpoint: "Employee/QUERY", recordIdField: "Id", modifiedField: "Modified", pagination: "resource_id_keyset", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["companies", "operational_units"], productDomains: ["workforce"], canonicalTargets: ["worker", "employment_episode"] },
    { id: "rosters", resource: "Roster", endpoint: "Roster/QUERY", recordIdField: "Id", modifiedField: "Modified", pagination: "resource_id_keyset", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["companies", "operational_units", "employees"], productDomains: ["workforce"], canonicalTargets: ["workforce_shift"] },
    { id: "timesheets", resource: "Timesheet", endpoint: "Timesheet/QUERY", recordIdField: "Id", modifiedField: "Modified", pagination: "resource_id_keyset", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["companies", "operational_units", "employees"], productDomains: ["workforce"], canonicalTargets: ["workforce_time_entry"] },
    { id: "leave", resource: "Leave", endpoint: "Leave/QUERY", recordIdField: "Id", modifiedField: "Modified", pagination: "resource_id_keyset", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["companies", "operational_units", "employees"], productDomains: ["workforce"], canonicalTargets: ["workforce_leave"] },
    { id: "contacts", resource: "Contact", endpoint: "Contact/QUERY", recordIdField: "Id", modifiedField: "Modified", pagination: "resource_id_keyset", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", availability: "optional", dependencies: [], productDomains: ["workforce"], canonicalTargets: ["person"] },
  ],
  rateLimit: {
    algorithm: "Retry-After when supplied plus bounded full-jitter exponential backoff",
    concurrency: 4,
    budgets: { resourceQueryMaxRecords: 500 },
    responseHeaders: ["Retry-After"],
  },
  capabilities: {
    "workforce.shifts": {
      support: "unknown", streams: ["rosters"],
      reason: "Confirmed only after a successful live Roster Resource query.",
    },
    "workforce.time_entries": {
      support: "unknown", streams: ["timesheets"],
      reason: "Confirmed only after a successful live Timesheet Resource query.",
    },
    "workforce.time_entries.cost": {
      support: "partial", streams: ["timesheets"], coverageFields: ["Cost", "OnCost"], requiresObservedCoverage: true,
      reason: "Payroll visibility and approval state determine observed labour-cost coverage.",
    },
    "workforce.time_entries.overtime": {
      support: "unavailable", streams: ["timesheets"],
      reason: "The pinned Timesheet projection does not expose a governed overtime duration; zero must never be presented as observed overtime.",
    },
    "workforce.leave": {
      support: "unknown", streams: ["leave"],
      reason: "Confirmed only after a successful live Leave Resource query.",
    },
    "source.webhooks": {
      support: "partial", streams: [],
      reason: "Webhook ingress is an optional accelerator that requires explicit owner or operator installation; polling and reconciliation are the complete baseline.",
    },
  },
  identityRules: [
    "Employee ContactObject work email exact within tenant is the strongest deterministic suggestion to a Lightspeed employee.",
    "Employee payroll or export number may be used as an exact deterministic key when present.",
    "Employee normalized name plus confirmed location is a review suggestion only, never an automatic merge.",
    "Company and OperationalUnit name plus address produce location review cards against Lightspeed Shops.",
  ],
  topology: [
    "Roster is planned work and Timesheet is actual work; they remain distinct canonical facts.",
    "Company is a Deputy location and OperationalUnit is an area within a company.",
    "Overnight intervals retain start and end instants; business-date allocation belongs in canonical transforms using the tenant cutoff.",
    "Employee ID anchors person and worker identity; Employee ID plus StartDate anchors each effective-dated employment episode.",
  ],
  fieldCoverage: [
    ...coverage("companies", { Id: "location.source_id", CompanyName: "location.name", TradingName: "location.trading_name", CompanyNumber: "location.external_code", Active: "location.active", Address: "location.address_source_id", Contact: "location.contact_source_id", Modified: "location.source_updated_at" }, ["Code", "ParentCompany", "IsWorkplace", "IsPayrollEntity", "PayrollExportCode", "Created"]),
    ...unsupportedCoverage("companies", DEPUTY_REVIEWED_UNSUPPORTED_FIELDS.companies, "Documented source audit identity is retained in immutable raw storage but is outside the V1 Company projection.", { Creator: "business_contact" }),
    { stream: "companies", field: "AddressObject", disposition: "canonical", stagingType: "jsonb", target: "identity_evidence.location_address", pii: "business_contact" },
    ...coverage("operational_units", { Id: "location.source_area_id", Company: "location.parent_source_id", OperationalUnitName: "location.name", Active: "location.active", Address: "location.address_source_id", Contact: "location.contact_source_id", Modified: "location.source_updated_at" }, ["WorkType", "ParentOperationalUnit", "PayrollExportName", "RosterSortOrder", "ShowOnRoster", "Colour", "OperationalUnitType", "Created"], { WorkType: "free_text_untrusted" }),
    ...unsupportedCoverage("operational_units", DEPUTY_REVIEWED_UNSUPPORTED_FIELDS.operational_units, "Documented OperationalUnit INFO metadata is retained in immutable raw storage but has no governed V1 semantic target.", { Creator: "business_contact", RosterActiveHoursSchedule: "payroll_sensitive", DailyRosterBudget: "payroll_sensitive" }),
    { stream: "operational_units", field: "AddressObject", disposition: "canonical", stagingType: "jsonb", target: "identity_evidence.location_address", pii: "business_contact" },
    ...coverage("employees", { Id: "worker.source_id", Company: "location.source_id", FirstName: "person.first_name", LastName: "person.last_name", DisplayName: "person.display_name", Active: "employment_episode.active", StartDate: "employment_episode.valid_from", TerminationDate: "employment_episode.valid_to", Contact: "person.contact_source_id", Modified: "worker.source_updated_at" }, ["EmployeeId", "OtherName", "Role", "User", "Created"], { FirstName: "employee_contact", LastName: "employee_contact", DisplayName: "employee_contact", OtherName: "employee_contact" }),
    ...unsupportedCoverage("employees", DEPUTY_REVIEWED_UNSUPPORTED_FIELDS.employees, "Documented employee profile, audit, and sensitive HR fields are retained in immutable raw storage but deliberately excluded from V1 analytics.", {
      Saluation: "employee_contact", Salutation: "employee_contact", MainAddress: "employee_contact", PostalAddress: "employee_contact", EmergencyAddress: "employee_contact", DateOfBirth: "payroll_sensitive", Gender: "payroll_sensitive", Pronouns: "employee_contact", CustomPronouns: "employee_contact", Photo: "employee_contact", StressProfile: "payroll_sensitive", TrainingRecords: "payroll_sensitive", HistoryId: "payroll_sensitive", Creator: "payroll_sensitive",
    }),
    ...coverage("rosters", { Id: "workforce_shift.source_id", Employee: "worker.source_id", OperationalUnit: "location.source_area_id", Date: "workforce_shift.business_date", StartTime: "workforce_shift.started_at", EndTime: "workforce_shift.ended_at", TotalTime: "workforce_shift.rostered_hours", Cost: "workforce_shift.rostered_cost", Published: "workforce_shift.published", Modified: "workforce_shift.source_updated_at" }, ["Mealbreak", "Slots", "Comment", "Open", "MatchedByTimesheet", "Created"], { Comment: "free_text_untrusted" }),
    ...unsupportedCoverage("rosters", DEPUTY_REVIEWED_UNSUPPORTED_FIELDS.rosters, "Documented roster workflow and audit fields are retained in immutable raw storage but are not assigned V1 canonical meaning.", { Warning: "free_text_untrusted", WarningOverrideComment: "free_text_untrusted", CustomFieldData: "free_text_untrusted", ConfirmComment: "free_text_untrusted", ConfirmBy: "employee_contact", SwapManageBy: "employee_contact", Creator: "employee_contact" }),
    ...coverage("timesheets", { Id: "workforce_time_entry.source_id", Employee: "worker.source_id", Roster: "workforce_shift.source_id", OperationalUnit: "location.source_area_id", Date: "workforce_time_entry.business_date", StartTime: "workforce_time_entry.started_at", EndTime: "workforce_time_entry.ended_at", TotalTime: "workforce_time_entry.worked_hours", Cost: "workforce_time_entry.cost", OnCost: "workforce_time_entry.on_cost", TimeApproved: "workforce_time_entry.approved", Discarded: "workforce_time_entry.discarded", IsLeave: "workforce_time_entry.is_leave", Modified: "workforce_time_entry.source_updated_at" }, ["Mealbreak", "MealbreakSlots", "PayRuleApproved", "Exported", "StartTimeLocalized", "EndTimeLocalized", "Created", "EmployeeComment"], { Cost: "payroll_sensitive", OnCost: "payroll_sensitive", EmployeeComment: "free_text_untrusted" }),
    ...unsupportedCoverage("timesheets", DEPUTY_REVIEWED_UNSUPPORTED_FIELDS.timesheets, "Documented timesheet payroll, workflow, and audit fields are retained in immutable raw storage but remain outside the reviewed V1 projection.", { EmployeeHistory: "payroll_sensitive", EmployeeAgreement: "payroll_sensitive", TotalTimeInv: "payroll_sensitive", SupervisorComment: "free_text_untrusted", Supervisor: "employee_contact", TimeApprover: "employee_contact", InvoiceComment: "free_text_untrusted", PayCycleId: "payroll_sensitive", File: "payroll_sensitive", CustomFieldDate: "payroll_sensitive", Creator: "payroll_sensitive" }),
    ...coverage("leave", {
      Id: "workforce_leave.source_id",
      Employee: "worker.source_id",
      Company: "location.source_id",
      LeaveRule: "workforce_leave.leave_rule_source_id",
      Start: "workforce_leave.started_at",
      End: "workforce_leave.ended_at",
      DateStart: "workforce_leave.business_date",
      DateEnd: "workforce_leave.source_end_date",
      Days: "workforce_leave.days",
      TotalHours: "workforce_leave.hours",
      Status: "workforce_leave.status",
      Modified: "workforce_leave.source_updated_at",
    }, [
      "TimeZone", "StartTimeLocalized", "EndTimeLocalized", "EmployeeHistory",
      "ApproverTime", "ApproverPay", "Creator", "AllDay", "DateStartAllDay",
      "DateEndAllDay", "NotifyManagerArray", "LeavePayLineArray", "Comment",
      "ApprovalComment", "ExternalID", "Created",
    ], {
      Start: "payroll_sensitive",
      End: "payroll_sensitive",
      StartTimeLocalized: "payroll_sensitive",
      EndTimeLocalized: "payroll_sensitive",
      EmployeeHistory: "payroll_sensitive",
      ApproverTime: "payroll_sensitive",
      ApproverPay: "payroll_sensitive",
      Creator: "payroll_sensitive",
      NotifyManagerArray: "employee_contact",
      LeavePayLineArray: "payroll_sensitive",
      Comment: "free_text_untrusted",
      ApprovalComment: "free_text_untrusted",
    }),
    {
      stream: "leave",
      field: "_DPMetaData",
      disposition: "unsupported",
      stagingType: "jsonb",
      reason: "Opaque Deputy presentation metadata can contain creator profiles and media URLs; retained in immutable raw storage only.",
      pii: "employee_contact",
    },
    ...coverage("contacts", { Id: "person.contact_source_id", Email1: "entity_source_link.email", Phone1: "entity_source_link.phone", Modified: "person.source_updated_at" }, ["Email2", "Phone2", "Phone3", "PrimaryEmail", "PrimaryPhone", "Notes", "Created"], { Email1: "employee_contact", Email2: "employee_contact", Phone1: "employee_contact", Phone2: "employee_contact", Phone3: "employee_contact", Notes: "free_text_untrusted" }),
    ...unsupportedCoverage("contacts", DEPUTY_REVIEWED_UNSUPPORTED_FIELDS.contacts, "Documented secondary contact channels and audit fields are retained in immutable raw storage but excluded from V1 identity matching.", { Fax: "employee_contact", Phone1Type: "employee_contact", Phone2Type: "employee_contact", Phone3Type: "employee_contact", Email1Type: "employee_contact", Email2Type: "employee_contact", Im1: "employee_contact", Im2: "employee_contact", Im1Type: "employee_contact", Im2Type: "employee_contact", Web: "business_contact", Creator: "employee_contact" }),
  ],
  qualityAssertions: [
    "cursor_completeness",
    "scope_available",
    "retention_limit_recorded",
    "webhook_gap_recovered",
    "delete_handling",
    "schema_drift",
    "enum_drift",
    "shift_timesheet_coverage_source",
  ],
  limitations: [
    "Deputy publishes no fixed global API-call budget in the pinned public docs; Albert obeys Retry-After and uses bounded adaptive retries rather than inventing a vendor limit.",
    "Contact Resource access is documented for Premium and Enterprise plans and may be unavailable on other plans.",
    "Deputy's current Webhook action catalogue does not list Contact. Contact is recovered by incremental polling and nightly reconciliation rather than an undocumented vendor trigger.",
    "Timesheet cost fields depend on payroll visibility and approval state; labour-cost capability remains partial or unavailable until live field coverage proves it.",
    "Albert never creates or updates Deputy Webhook resources. Optional webhook acceleration requires explicit owner or operator installation of connection-bound callback material; OAuth, scheduled polling, and reconciliation remain fully usable without it.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
