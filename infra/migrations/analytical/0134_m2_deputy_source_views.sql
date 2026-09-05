-- 0134_m2_deputy_source_views.sql
--
-- Curated, tenant-secured surface over the raw Deputy ingestion (DEPUTYNEW).
--
-- The raw dlt load carries Deputy's native PascalCase columns and no tenancy
-- envelope (no tenant_id / mapping_version / tombstone). Instead of teaching
-- the semantic layer to read that shape, this migration exposes a clean
-- source_deputy schema of views that:
--   1. stamp tenant_id from source_deputy.tenant_binding (one row today; a
--      per-install mapping when Deputy becomes multi-tenant),
--   2. enforce the same capability check as the Lightspeed RLS policies
--      (rows only appear when ingestion.current_tenant_id() matches),
--   3. rename to snake_case, coalesce dlt variant columns (Cost__v_double),
--      and drop Deputy's junk columns (MealbreakSlots___* explosion),
--   4. exclude voided rows (Discarded timesheets) the way tombstoned rows
--      are excluded from Lightspeed staging.
--
-- semantic_ro receives SELECT on the views only, never on DEPUTYNEW; the
-- views run with definer rights, so raw-table grants stay closed.

BEGIN;

CREATE SCHEMA IF NOT EXISTS source_deputy;

CREATE TABLE IF NOT EXISTS source_deputy.tenant_binding (
  tenant_id text PRIMARY KEY
);

INSERT INTO source_deputy.tenant_binding (tenant_id)
VALUES ('01KZ4ZMVF5QNQ4TX35VF3WDJBM')
ON CONFLICT DO NOTHING;

-- Employees ------------------------------------------------------------------

CREATE OR REPLACE VIEW source_deputy.dp_employees
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || e."Id" AS row_key,
  e."Id"              AS employee_id,
  e."FirstName"       AS first_name,
  e."LastName"        AS last_name,
  e."DisplayName"     AS display_name,
  e."Position"        AS position,
  e."Active"          AS active,
  e."Paused"          AS paused,
  e."StartDate"       AS started_on,
  e."TerminationDate" AS terminated_on,
  e."Company"         AS company_id,
  e."Role"            AS role_id,
  e."Created"         AS created_at,
  e."Modified"        AS modified_at
FROM "DEPUTYNEW".deputy_employee e
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_deputy.dp_employee_roles
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || r."Id" AS row_key,
  r."Id"      AS role_id,
  r."Role"    AS role_name,
  r."Ranking" AS ranking
FROM "DEPUTYNEW".deputy_employeerole r
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Locations / areas ------------------------------------------------------------

CREATE OR REPLACE VIEW source_deputy.dp_operational_units
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || u."Id" AS row_key,
  u."Id"                  AS operational_unit_id,
  u."OperationalUnitName" AS unit_name,
  u."Company"             AS company_id,
  u."CompanyName"         AS company_name,
  u."Active"              AS active,
  u."AddressObject__City" AS city,
  u."AddressObject__State" AS state
FROM "DEPUTYNEW".deputy_operationalunit u
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_deputy.dp_companies
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || c."Id" AS row_key,
  c."Id"           AS company_id,
  c."CompanyName"  AS company_name,
  c."TradingName"  AS trading_name,
  c."Active"       AS active,
  c."IsWorkplace"  AS is_workplace,
  c."IsPayrollEntity" AS is_payroll_entity
FROM "DEPUTYNEW".deputy_company c
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Timesheets (actual worked time) ----------------------------------------------

CREATE OR REPLACE VIEW source_deputy.dp_timesheets
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t."Id" AS row_key,
  t."Id"                 AS timesheet_id,
  t."Employee"           AS employee_id,
  t."_DPMetaData__EmployeeInfo__DisplayName" AS employee_name,
  t."Date"               AS shift_date,
  t."StartTimeLocalized" AS started_at,
  t."EndTimeLocalized"   AS ended_at,
  t."TotalTime"          AS paid_hours,
  COALESCE(t."Cost__v_double", t."Cost"::double precision)     AS wage_cost,
  COALESCE(t."OnCost__v_double", t."OnCost"::double precision) AS loaded_cost,
  t."TimeApproved"       AS time_approved,
  t."PayRuleApproved"    AS pay_approved,
  t."IsInProgress"       AS in_progress,
  t."IsLeave"            AS is_leave,
  t."LeaveId"            AS leave_id,
  t."LeaveRule"          AS leave_rule_id,
  t."OperationalUnit"    AS operational_unit_id,
  t."_DPMetaData__OperationalUnitInfo__OperationalUnitName" AS unit_name,
  t."_DPMetaData__OperationalUnitInfo__CompanyName"         AS company_name,
  t."Roster"             AS roster_id,
  t."EmployeeComment"    AS employee_comment,
  t."Created"            AS created_at,
  t."Modified"           AS modified_at
FROM "DEPUTYNEW".deputy_timesheet t
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(t."Discarded", false);

-- Rosters (scheduled shifts) ----------------------------------------------------

CREATE OR REPLACE VIEW source_deputy.dp_rosters
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || r."Id" AS row_key,
  r."Id"                 AS roster_id,
  r."Employee"           AS employee_id,
  r."_DPMetaData__EmployeeInfo__DisplayName" AS employee_name,
  r."Date"               AS shift_date,
  r."StartTimeLocalized" AS starts_at,
  r."EndTimeLocalized"   AS ends_at,
  r."TotalTime"          AS scheduled_hours,
  COALESCE(r."Cost__v_double", r."Cost"::double precision) AS scheduled_cost,
  r."Published"          AS published,
  r."Open"               AS open_shift,
  r."MatchedByTimesheet" AS matched_timesheet_id,
  r."OperationalUnit"    AS operational_unit_id,
  r."_DPMetaData__OperationalUnitInfo__OperationalUnitName" AS unit_name,
  r."_DPMetaData__OperationalUnitInfo__CompanyName"         AS company_name,
  r."Comment"            AS comment,
  r."ConfirmStatus"      AS confirm_status,
  r."Created"            AS created_at,
  r."Modified"           AS modified_at
FROM "DEPUTYNEW".deputy_roster r
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Leave --------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_deputy.dp_leave
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."Id" AS row_key,
  l."Id"           AS leave_id,
  l."Employee"     AS employee_id,
  l."EmployeeName" AS employee_name,
  l."Company"      AS company_id,
  l."DateStart"    AS starts_on,
  l."DateEnd"      AS ends_on,
  COALESCE(l."Days__v_double", l."Days"::double precision)             AS days,
  COALESCE(l."TotalHours__v_double", l."TotalHours"::double precision) AS total_hours,
  l."Status"       AS status_code,
  CASE l."Status"
    WHEN 0 THEN 'Awaiting approval'
    WHEN 1 THEN 'Approved'
    WHEN 2 THEN 'Declined'
    WHEN 3 THEN 'Cancelled'
    WHEN 4 THEN 'Date approved'
    WHEN 5 THEN 'Pay approved'
    ELSE 'Unknown'
  END              AS status,
  l."LeaveRule"    AS leave_rule_id,
  l."Comment"      AS comment,
  l."ApprovalComment" AS approval_comment,
  l."Created"      AS created_at,
  l."Modified"     AS modified_at
FROM "DEPUTYNEW".deputy_leave l
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_deputy.dp_leave_rules
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || lr."Id" AS row_key,
  lr."Id"          AS leave_rule_id,
  lr."Name"        AS rule_name,
  lr."PaidLeave"   AS paid_leave,
  lr."Visible"     AS visible,
  lr."Description" AS description
FROM "DEPUTYNEW".deputy_leaverules lr
CROSS JOIN source_deputy.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Grants ---------------------------------------------------------------------

GRANT USAGE ON SCHEMA source_deputy TO semantic_ro;
GRANT SELECT ON source_deputy.dp_employees,
                source_deputy.dp_employee_roles,
                source_deputy.dp_operational_units,
                source_deputy.dp_companies,
                source_deputy.dp_timesheets,
                source_deputy.dp_rosters,
                source_deputy.dp_leave,
                source_deputy.dp_leave_rules
TO semantic_ro;

COMMIT;
