-- 0176: Deputy leave at day grain, in the organisation's local calendar.
--
-- Deputy stores a leave request's DateStart/DateEnd as UTC instants of local
-- midnight (31 Jul 2026 in Melbourne lands as 2026-07-30 14:00Z) together with
-- the request's timezone. "Who is on leave this month" is an OVERLAP question
-- - a request starting 31 July and ending 2 August is on leave in August -
-- which a single start-date filter cannot express, so the engine fell back to
-- multi-step investigation (100 s+). This migration adds the local start/end
-- dates to dp_leave and a dp_leave_days view with one row per leave request
-- per local calendar day, so "who is on leave in <period>" is one query on a
-- day dimension.

BEGIN;

CREATE OR REPLACE VIEW source_deputy.dp_leave
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l.id::text AS row_key,
  l.id             AS leave_id,
  l.employee_id    AS employee_id,
  h.display_name   AS employee_name,
  l.company_id     AS company_id,
  l.date_start     AS starts_on,
  l.date_end       AS ends_on,
  l.days           AS days,
  l.total_hours    AS total_hours,
  l.status         AS status_code,
  CASE l.status
    WHEN 0 THEN 'Awaiting approval'
    WHEN 1 THEN 'Approved'
    WHEN 2 THEN 'Declined'
    WHEN 3 THEN 'Cancelled'
    WHEN 4 THEN 'Date approved'
    WHEN 5 THEN 'Pay approved'
    ELSE 'Unknown'
  END              AS status,
  l.leave_rule_id  AS leave_rule_id,
  l.comment        AS comment,
  l.approval_comment AS approval_comment,
  l.created        AS created_at,
  l.modified       AS modified_at,
  -- Appended (CREATE OR REPLACE keeps earlier columns in place).
  COALESCE(NULLIF(l.timezone, ''), 'UTC') AS timezone,
  (l.date_start AT TIME ZONE COALESCE(NULLIF(l.timezone, ''), 'UTC'))::date AS starts_on_local,
  (l.date_end   AT TIME ZONE COALESCE(NULLIF(l.timezone, ''), 'UTC'))::date AS ends_on_local
FROM source_deputy_fivetran.employee_leave l
LEFT JOIN source_deputy_fivetran.employee e
  ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
LEFT JOIN source_deputy_fivetran.employee_history h
  ON h.tenant_id = l.tenant_id AND h.id = e.history_id
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(l._fivetran_deleted, false);

CREATE OR REPLACE VIEW source_deputy.dp_leave_days
WITH (security_barrier = true) AS
SELECT
  leave.tenant_id,
  leave.row_key || ':' || day.leave_day::text AS row_key,
  leave.leave_id,
  leave.employee_id,
  leave.employee_name,
  leave.company_id,
  leave.leave_rule_id,
  leave.status_code,
  leave.status,
  leave.starts_on_local,
  leave.ends_on_local,
  day.leave_day::date AS leave_day,
  (leave.ends_on_local - leave.starts_on_local) + 1 AS span_days,
  leave.days,
  leave.total_hours,
  CASE WHEN (leave.ends_on_local - leave.starts_on_local) + 1 > 0
       THEN leave.days / ((leave.ends_on_local - leave.starts_on_local) + 1)
  END AS days_per_day,
  CASE WHEN (leave.ends_on_local - leave.starts_on_local) + 1 > 0
       THEN leave.total_hours / ((leave.ends_on_local - leave.starts_on_local) + 1)
  END AS hours_per_day
FROM source_deputy.dp_leave AS leave
CROSS JOIN LATERAL generate_series(
  leave.starts_on_local,
  GREATEST(leave.starts_on_local, LEAST(leave.ends_on_local, leave.starts_on_local + 366)),
  interval '1 day'
) AS day(leave_day)
WHERE leave.starts_on_local IS NOT NULL;

COMMENT ON VIEW source_deputy.dp_leave_days IS
  'One row per Deputy leave request per local calendar day it covers (capped at 367 days); lets "who is on leave in <period>" be a single day-range query. days_per_day / hours_per_day spread the request''s days and hours evenly across its span.';

GRANT SELECT ON source_deputy.dp_leave, source_deputy.dp_leave_days TO semantic_ro;

COMMIT;
