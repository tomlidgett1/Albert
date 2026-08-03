import { z } from "zod";

const id = z.union([z.number().int(), z.string().min(1)]);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const deputyCompanySchema = z.object({
  Id: id,
  CompanyName: z.string(),
  Active: scalar.optional(),
  Modified: z.string().optional(),
  AddressObject: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();

export const deputyOperationalUnitSchema = z.object({
  Id: id,
  Company: id,
  OperationalUnitName: z.string(),
  Active: scalar.optional(),
  Modified: z.string().optional(),
  AddressObject: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();

export const deputyEmployeeSchema = z.object({
  Id: id,
  Company: id,
  FirstName: z.string(),
  LastName: z.string(),
  DisplayName: z.string(),
  Active: scalar,
  Modified: z.string().optional(),
}).passthrough();

export const deputyRosterSchema = z.object({
  Id: id,
  Employee: id.nullable().optional(),
  OperationalUnit: id,
  Date: z.string(),
  StartTime: scalar.optional(),
  EndTime: scalar.optional(),
  TotalTime: scalar.optional(),
  Cost: scalar.optional(),
  Modified: z.string().optional(),
}).passthrough();

export const deputyTimesheetSchema = z.object({
  Id: id,
  Employee: id,
  OperationalUnit: id,
  Date: z.string(),
  StartTime: scalar.optional(),
  EndTime: scalar.optional(),
  TotalTime: scalar.optional(),
  Cost: scalar.optional(),
  Modified: z.string().optional(),
}).passthrough();

export const deputyLeaveSchema = z.object({
  Id: id,
  Employee: id,
  Company: id,
  DateStart: z.string(),
  DateEnd: z.string(),
  Start: scalar.optional(),
  End: scalar.optional(),
  TimeZone: z.string().optional(),
  Status: scalar,
  Modified: z.string().optional(),
}).passthrough();

export const deputyContactSchema = z.object({
  Id: id,
  Email1: z.string().nullable().optional(),
  Phone1: z.string().nullable().optional(),
  Modified: z.string().optional(),
}).passthrough();

export const deputySchemas = {
  companies: deputyCompanySchema,
  operational_units: deputyOperationalUnitSchema,
  employees: deputyEmployeeSchema,
  rosters: deputyRosterSchema,
  timesheets: deputyTimesheetSchema,
  leave: deputyLeaveSchema,
  contacts: deputyContactSchema,
} as const;

export type DeputyStreamId = keyof typeof deputySchemas;
