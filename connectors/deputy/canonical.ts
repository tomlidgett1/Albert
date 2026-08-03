import { Decimal4 } from "../../packages/canonical-schema/src/index.js";
import { stagingColumnName } from "../../packages/connector-sdk/src/index.js";
import type {
  CanonicalEntityType,
  CanonicalMappingContext,
  CanonicalProjectionCommand,
  CanonicalProjectionTable,
  CanonicalProjectionValue,
  CanonicalSourceReference,
  CanonicalStagingRow,
  CanonicalStreamMapper,
} from "../../services/sync-workers/src/canonical-contract.js";
import { deputyManifest } from "./manifest.js";

const ZERO = Decimal4.zero();
const COMMON_STAGING_COLUMNS = new Set([
  "tenant_id",
  "namespaced_source_key",
  "connection_id",
  "external_account_reference",
  "source_object_type",
  "source_record_id",
  "source_version",
  "source_updated_at",
  "payload_hash",
  "payload_batch_id",
  "sync_run_id",
  "tombstone",
  "mapping_version",
  "first_ingested_at",
  "ingested_at",
]);

/** Pure, fail-closed Deputy typed-staging to source-neutral canonical projection. */
export const mapDeputyCanonical: CanonicalStreamMapper = (stream, row, context) => {
  assertStagingRow(stream, row);
  switch (stream) {
    case "companies": return mapCompany(row, context);
    case "operational_units": return mapOperationalUnit(row, context);
    case "employees": return mapEmployee(row);
    case "rosters": return mapRoster(row, context);
    case "timesheets": return mapTimesheet(row, context);
    case "leave": return mapLeave(row, context);
    case "contacts": return mapContact(row);
    default: throw new Error(`deputy_canonical_stream_unsupported:${stream}`);
  }
};

function mapCompany(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.id, "companies.id");
  const companyName = requiredText(row.company_name, "companies.company_name");
  const name = optionalText(row.trading_name) ?? companyName;
  const address = deputyBusinessAddress(row.address_object);
  const active = truthy(row.active) && !row.tombstone;
  return [
    dimension("location", row.source_object_type, id, {
      name,
      timezone: context.timezone,
      legal_entity_id: null,
      active,
    }, row, "location"),
    identityHint("location", row.source_object_type, id, {
      externalId: optionalText(row.company_number) ?? id,
      deterministicKeys: {
        company_code: optionalText(row.code) ?? undefined,
        location_name_address: locationNameAddress(companyName, address),
      },
      normalizedName: normalizedName(companyName),
    }),
  ];
}

function mapOperationalUnit(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.id, "operational_units.id");
  const companyId = requiredIdentifier(row.company, "operational_units.company");
  const name = requiredText(row.operational_unit_name, "operational_units.operational_unit_name");
  const address = deputyBusinessAddress(row.address_object);
  const active = truthy(row.active) && !row.tombstone;
  return [
    dimension("location", row.source_object_type, id, {
      name,
      timezone: context.timezone,
      legal_entity_id: null,
      active,
    }, row, "location"),
    identityHint("location", row.source_object_type, id, {
      externalId: id,
      deterministicKeys: {
        payroll_export_name: optionalText(row.payroll_export_name) ?? undefined,
        location_name_address: locationNameAddress(name, address),
      },
      normalizedName: normalizedName(name),
      corroboratingScope: companyId,
    }),
  ];
}

function mapEmployee(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.id, "employees.id");
  const companyId = requiredIdentifier(row.company, "employees.company");
  const composedName = [optionalText(row.first_name), optionalText(row.last_name)].filter(Boolean).join(" ");
  const displayName = optionalText(row.display_name) ?? (composedName || `Employee ${id}`);
  const active = truthy(row.active) && !row.tombstone;
  const effectiveFrom = optionalDate(row.start_date)
    ?? optionalDate(row.created)
    ?? requiredDate(row.source_updated_at, "employees.effective_from");
  let effectiveTo = optionalDate(row.termination_date);
  if (effectiveTo && effectiveTo <= effectiveFrom) effectiveTo = null;
  if (!active && !effectiveTo) {
    const changedDate = optionalDate(row.source_updated_at);
    if (changedDate && changedDate > effectiveFrom) effectiveTo = changedDate;
  }
  const contactId = optionalIdentifier(row.contact);
  const payrollId = optionalText(row.employee_id) ?? undefined;
  return [
    dimension("person", row.source_object_type, id, { display_name: displayName }, row),
    dimension("worker", row.source_object_type, id, {
      person_id: sourceRef("person", "Employee", id, row),
      display_name: displayName,
      active,
    }, row, "worker"),
    dimension("employment_episode", row.source_object_type, id, {
      worker_id: sourceRef("worker", "Employee", id, row, { entityType: "worker" }),
      legal_entity_id: null,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      status: active ? "active" : "terminated",
    }, row),
    identityHint("worker", row.source_object_type, id, {
      externalId: payrollId,
      deterministicKeys: {
        payroll_number: payrollId,
        contact_id: contactId ?? undefined,
      },
      normalizedName: normalizedName(displayName),
      corroboratingScope: companyId,
      evidenceRefs: contactId ? [{ sourceObjectType: "Contact", sourceRecordId: contactId }] : undefined,
    }),
  ];
}

function mapRoster(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.id, "rosters.id");
  const workerId = optionalIdentifier(row.employee);
  if (!workerId) {
    return [{ kind: "metadata", sourceObjectType: row.source_object_type, sourceRecordId: id, classification: "lookup_only" }];
  }
  const locationId = requiredIdentifier(row.operational_unit, "rosters.operational_unit");
  const startsAt = requiredInstant(row.start_time, "rosters.start_time");
  const endsAt = requiredInstant(row.end_time, "rosters.end_time");
  assertPositiveInterval(startsAt, endsAt, `rosters:${id}`);
  const status = row.tombstone
    ? "cancelled"
    : truthy(row.open) ? "open" : truthy(row.published) ? "published" : "draft";
  return [fact("workforce_shift", row.source_object_type, id, {
    worker_id: sourceRef("worker", "Employee", workerId, row, { entityType: "worker" }),
    employment_episode_id: sourceRef("employment_episode", "Employee", workerId, row, { nullable: true }),
    location_id: sourceRef("location", "OperationalUnit", locationId, row, { entityType: "location" }),
    starts_at: startsAt,
    ends_at: endsAt,
    business_date: requiredDate(row.date, "rosters.date"),
    status,
    rostered_minutes: durationMinutes(row.total_time, startsAt, endsAt, "rosters.total_time"),
    estimated_cost: optionalDecimal(row.cost, "rosters.cost"),
    currency: context.baseCurrency,
  }, "planned_shifts", row.tombstone)];
}

function mapTimesheet(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.id, "timesheets.id");
  const workerId = requiredIdentifier(row.employee, "timesheets.employee");
  const locationId = requiredIdentifier(row.operational_unit, "timesheets.operational_unit");
  const startsAt = requiredInstant(row.start_time, "timesheets.start_time");
  const endsAt = requiredInstant(row.end_time, "timesheets.end_time");
  assertPositiveInterval(startsAt, endsAt, `timesheets:${id}`);
  const approved = truthy(row.time_approved);
  const discarded = truthy(row.discarded) || row.tombstone;
  const cost = optionalDecimalValue(row.cost, "timesheets.cost");
  const onCost = optionalDecimalValue(row.on_cost, "timesheets.on_cost");
  const labourCost = cost || onCost ? (cost ?? ZERO).add(onCost ?? ZERO).toString() : null;
  const commands: CanonicalProjectionCommand[] = [fact("workforce_time_entry", row.source_object_type, id, {
    worker_id: sourceRef("worker", "Employee", workerId, row, { entityType: "worker" }),
    employment_episode_id: sourceRef("employment_episode", "Employee", workerId, row, { nullable: true }),
    location_id: sourceRef("location", "OperationalUnit", locationId, row, { entityType: "location" }),
    starts_at: startsAt,
    ends_at: endsAt,
    approved_at: approved ? optionalInstant(row.source_updated_at) : null,
    business_date: requiredDate(row.date, "timesheets.date"),
    status: discarded ? "discarded" : truthy(row.is_leave) ? "leave" : approved ? "approved" : "pending",
    worked_minutes: durationMinutes(row.total_time, startsAt, endsAt, "timesheets.total_time"),
    overtime_minutes: 0,
    labour_cost: labourCost,
    currency: context.baseCurrency,
  }, "worked_hours", row.tombstone)];
  const rosterId = optionalIdentifier(row.roster);
  if (rosterId) {
    commands.push({
      kind: "event_link",
      linkType: "part_of_batch",
      from: { connectionId: row.connection_id, sourceObjectType: row.source_object_type, sourceRecordId: id },
      to: { connectionId: row.connection_id, sourceObjectType: "Roster", sourceRecordId: rosterId },
      evidence: { relationship: "actual_time_for_planned_shift", business_date: requiredDate(row.date, "timesheets.date") },
    });
  }
  return commands;
}

function mapLeave(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.id, "leave.id");
  const workerId = requiredIdentifier(row.employee, "leave.employee");
  const companyId = optionalIdentifier(row.company);
  const startDate = requiredDate(row.date_start, "leave.date_start");
  const inclusiveEndDate = requiredDate(row.date_end, "leave.date_end");
  const endExclusive = addDays(inclusiveEndDate, 1);
  const sourceStart = optionalInstant(row.start);
  const sourceEnd = optionalInstant(row.end);
  if ((sourceStart && !sourceEnd) || (!sourceStart && sourceEnd)) {
    throw new Error(`deputy_canonical_leave_interval_partial:${id}`);
  }
  const timezone = optionalText(row.time_zone) ?? context.timezone;
  const startsAt = sourceStart ?? zonedStartOfDay(startDate, timezone, `leave:${id}:start`);
  const endsAt = sourceEnd ?? zonedStartOfDay(endExclusive, timezone, `leave:${id}:end`);
  assertPositiveInterval(startsAt, endsAt, `leave:${id}`);
  const totalHours = optionalDecimalValue(row.total_hours, "leave.total_hours");
  const days = optionalDecimalValue(row.days, "leave.days");
  const minutes = totalHours
    ? decimalHoursToMinutes(totalHours, "leave.total_hours")
    : days ? decimalHoursToMinutes(days.multiply("8"), "leave.days") : 0;
  return [fact("workforce_leave", row.source_object_type, id, {
    worker_id: sourceRef("worker", "Employee", workerId, row, { entityType: "worker" }),
    employment_episode_id: sourceRef("employment_episode", "Employee", workerId, row, { nullable: true }),
    location_id: companyId
      ? sourceRef("location", "Company", companyId, row, { entityType: "location", nullable: true })
      : null,
    starts_at: startsAt,
    ends_at: endsAt,
    business_date: startDate,
    status: row.tombstone ? "cancelled" : deputyLeaveStatus(row.status),
    leave_type: optionalIdentifier(row.leave_rule) ?? "unknown",
    leave_minutes: minutes,
    leave_cost: null,
    currency: context.baseCurrency,
  }, "worked_hours", row.tombstone)];
}

function mapContact(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.id, "contacts.id");
  const email = optionalText(row.email1)?.toLowerCase() ?? undefined;
  const phone = normalizePhone(row.phone1) ?? undefined;
  return [
    identityHint("worker", row.source_object_type, id, {
      deterministicKeys: { contact_id: id, work_email: email, phone },
      evidenceOnly: true,
    }),
    {
      kind: "metadata",
      sourceObjectType: row.source_object_type,
      sourceRecordId: id,
      classification: "identity_evidence",
    },
  ];
}

function assertStagingRow(stream: string, row: CanonicalStagingRow): void {
  const contract = deputyManifest.streams.find((candidate) => candidate.id === stream);
  if (!contract) throw new Error(`deputy_canonical_stream_unsupported:${stream}`);
  if (row.source_object_type !== contract.resource) {
    throw new Error(`deputy_canonical_source_type_mismatch:${stream}:${row.source_object_type}`);
  }
  const coverage = deputyManifest.fieldCoverage.filter(
    (field) => field.stream === stream && field.disposition !== "unsupported",
  );
  const allowed = new Set([...COMMON_STAGING_COLUMNS, ...coverage.map((field) => stagingColumnName(field.field))]);
  const drift = Object.keys(row).filter((column) => !allowed.has(column));
  if (drift.length > 0) throw new Error(`deputy_canonical_staging_drift:${stream}:${drift.sort().join(",")}`);
  const stagedId = requiredIdentifier(row[stagingColumnName(contract.recordIdField)], `${stream}.record_id`);
  if (stagedId !== row.source_record_id) {
    throw new Error(`deputy_canonical_source_id_mismatch:${stream}:${stagedId}:${row.source_record_id}`);
  }
}

function dimension(
  table: CanonicalProjectionTable,
  sourceObjectType: string,
  sourceRecordId: string,
  values: Readonly<Record<string, CanonicalProjectionValue>>,
  row: CanonicalStagingRow,
  entityType?: CanonicalEntityType,
): CanonicalProjectionCommand {
  return {
    kind: "dimension",
    table,
    sourceObjectType,
    sourceRecordId,
    values,
    tombstone: row.tombstone || undefined,
    entityType,
  } as CanonicalProjectionCommand;
}

function fact(
  table: CanonicalProjectionTable,
  sourceObjectType: string,
  sourceRecordId: string,
  values: Readonly<Record<string, CanonicalProjectionValue>>,
  authorityConcept: "planned_shifts" | "worked_hours",
  tombstone = false,
): CanonicalProjectionCommand {
  return {
    kind: "fact",
    table,
    sourceObjectType,
    sourceRecordId,
    values,
    authorityConcept,
    tombstone: tombstone || undefined,
  } as CanonicalProjectionCommand;
}

function identityHint(
  entityType: CanonicalEntityType,
  sourceObjectType: string,
  sourceRecordId: string,
  fields: Readonly<{
    externalId?: string;
    deterministicKeys: Readonly<Record<string, string | undefined>>;
    normalizedName?: string;
    corroboratingScope?: string;
    evidenceRefs?: readonly Readonly<{ sourceObjectType: string; sourceRecordId: string }>[];
    evidenceOnly?: boolean;
  }>,
): CanonicalProjectionCommand {
  return { kind: "identity_hint", entityType, sourceObjectType, sourceRecordId, ...fields };
}

function sourceRef(
  table: CanonicalProjectionTable,
  sourceObjectType: string,
  sourceRecordId: string,
  row: CanonicalStagingRow,
  options: Readonly<{ entityType?: CanonicalEntityType; nullable?: boolean }> = {},
): CanonicalSourceReference {
  return {
    sourceRef: {
      table,
      sourceObjectType,
      sourceRecordId,
      connectionId: row.connection_id,
      ...options,
    },
  };
}

function durationMinutes(value: unknown, startsAt: string, endsAt: string, path: string): number {
  const hours = optionalDecimalValue(value, path);
  if (hours) return decimalHoursToMinutes(hours, path);
  return Math.max(0, Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000));
}

function decimalHoursToMinutes(hours: Decimal4, path: string): number {
  if (hours.scaled < 0n) throw new Error(`deputy_canonical_duration_negative:${path}`);
  const minuteScaled = hours.scaled * 60n;
  const rounded = (minuteScaled + 5_000n) / 10_000n;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new Error(`deputy_canonical_duration_overflow:${path}`);
  return value;
}

function optionalDecimal(value: unknown, path: string): string | null {
  return optionalDecimalValue(value, path)?.toString() ?? null;
}

function optionalDecimalValue(value: unknown, path: string): Decimal4 | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`deputy_canonical_decimal_invalid:${path}`);
  }
  try {
    return Decimal4.from(typeof value === "bigint" ? value : String(value));
  } catch {
    throw new Error(`deputy_canonical_decimal_invalid:${path}`);
  }
}

function requiredText(value: unknown, path: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`deputy_canonical_text_missing:${path}`);
  return text;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function requiredIdentifier(value: unknown, path: string): string {
  const id = optionalIdentifier(value);
  if (!id) throw new Error(`deputy_canonical_id_missing:${path}`);
  return id;
}

function optionalIdentifier(value: unknown): string | null {
  const id = optionalText(value);
  return id && id !== "0" ? id : null;
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["1", "true", "yes", "active", "approved", "published"].includes(value.trim().toLowerCase());
}

function requiredDate(value: unknown, path: string): string {
  const date = optionalDate(value);
  if (!date) throw new Error(`deputy_canonical_date_missing:${path}`);
  return date;
}

function optionalDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const text = optionalText(value);
  const match = text ? /^(\d{4}-\d{2}-\d{2})/u.exec(text) : null;
  return match && !Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) ? match[1] : null;
}

function requiredInstant(value: unknown, path: string): string {
  const instant = optionalInstant(value);
  if (!instant) throw new Error(`deputy_canonical_timestamp_missing:${path}`);
  return instant;
}

function optionalInstant(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function zonedStartOfDay(value: string, timezone: string, path: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error(`deputy_canonical_date_missing:${path}`);
  const target = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const localEpoch = Date.UTC(target.year, target.month - 1, target.day);
  let instant = localEpoch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedDateTimeParts(instant, timezone, path);
    const observedEpoch = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const adjustment = localEpoch - observedEpoch;
    instant += adjustment;
    if (adjustment === 0) break;
  }
  const resolved = zonedDateTimeParts(instant, timezone, path);
  if (
    resolved.year !== target.year ||
    resolved.month !== target.month ||
    resolved.day !== target.day ||
    resolved.hour !== 0 ||
    resolved.minute !== 0 ||
    resolved.second !== 0
  ) {
    throw new Error(`deputy_canonical_local_midnight_unresolvable:${path}`);
  }
  return new Date(instant).toISOString();
}

function zonedDateTimeParts(
  instant: number,
  timezone: string,
  path: string,
): Readonly<Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>> {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`deputy_canonical_timezone_invalid:${path}`);
  }
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(instant))
      .filter((part) => ["year", "month", "day", "hour", "minute", "second"].includes(part.type))
      .map((part) => [part.type, Number(part.value)]),
  ) as Partial<Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>>;
  for (const key of ["year", "month", "day", "hour", "minute", "second"] as const) {
    if (!Number.isInteger(values[key])) throw new Error(`deputy_canonical_local_time_missing:${path}:${key}`);
  }
  return values as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

function assertPositiveInterval(start: string, end: string, path: string): void {
  if (Date.parse(end) <= Date.parse(start)) throw new Error(`deputy_canonical_interval_invalid:${path}`);
}

function deputyLeaveStatus(value: unknown): string {
  const code = Number(optionalText(value));
  const statuses: Readonly<Record<number, string>> = {
    0: "awaiting_approval",
    1: "approved",
    2: "declined",
    3: "cancelled",
    4: "date_approved",
    5: "pay_approved",
  };
  return Number.isInteger(code) ? statuses[code] ?? "unknown" : "unknown";
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function deputyBusinessAddress(value: unknown): string | undefined {
  const address = asObject(value);
  if (!address) return undefined;
  const street = [address.UnitNo, address.StreetNo, address.Street1]
    .map(optionalText)
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const parts = [street, address.SuiteNo, address.Street2, address.City, address.Postcode]
    .map(optionalText)
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? normalizedName(parts.join("|")) : undefined;
}

function locationNameAddress(name: string, address: string | undefined): string | undefined {
  return address ? `${normalizedName(name)}\u001f${address}` : undefined;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function normalizePhone(value: unknown): string | null {
  const phone = optionalText(value);
  if (!phone) return null;
  const normalized = phone.replace(/(?!^\+)[^\d]/gu, "");
  return normalized.length > 0 ? normalized : null;
}
