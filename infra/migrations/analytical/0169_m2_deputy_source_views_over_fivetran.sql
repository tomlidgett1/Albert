-- 0169: Deputy's Cube contract reads Fivetran-landed data.
--
-- Deputy now syncs through Fivetran's native connector into one destination
-- schema per connection (deputy_<connection_ulid>). Unlike Albert's SDK Xero
-- connector, Fivetran's native connectors do NOT prefix their table names
-- (resource_timesheet, roster, employee ...), so:
--
--   * ingestion.rebuild_fivetran_source_views() drops its table-name prefix
--     filter (a bound schema's tables belong to the source by construction)
--     and instead excludes Fivetran's own bookkeeping tables. The
--     letter<->digit alias collapse (address_line_1 -> address_line1) now
--     applies only to SDK-prefixed tables, where the contract guarantees it
--     is invertible; native tables keep their landed names verbatim.
--   * Every ACTIVE binding is stamped (tenant_id + RLS) so a schema landed
--     before the worker's maintenance loop saw it is still secured here.
--   * source_deputy_fivetran.* union views are built.
--   * The source_deputy.dp_* views keep their exact output columns but read
--     source_deputy_fivetran instead of the retired dlt "DEPUTYNEW" schema.
--     Deputy's leave-rule NAMES have no Fivetran source, so the labels are
--     snapshotted once from "DEPUTYNEW" into a small physical table (they are
--     operator-defined and near-static).
--   * The duplicate schema deputy_01m07gdgdhd2ed2xxgq7rfh8zr (double-fired
--     connect; identical data; connection already disconnected and binding
--     retired) is dropped.
BEGIN;

-- 1. Union-view builder v2 -----------------------------------------------------

CREATE OR REPLACE FUNCTION ingestion.rebuild_fivetran_source_views(p_prefix text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_schema text;
  active record;
  table_name text;
  column_rec record;
  branch_sql text;
  select_list text;
  branches text[];
  leader_schema text;
  rebuilt integer := 0;
  present boolean;
  sdk_shaped boolean;
  alias_name text;
BEGIN
  IF p_prefix IS NULL OR p_prefix !~ '^[a-z][a-z0-9_]{0,31}$' THEN
    RAISE EXCEPTION 'fivetran source prefix is invalid' USING ERRCODE = '22023';
  END IF;
  target_schema := 'source_' || p_prefix || '_fivetran';
  IF to_regnamespace(target_schema) IS NULL THEN
    EXECUTE format('CREATE SCHEMA %I', target_schema);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO transform_rw, diagnostic_ro', target_schema);
  END IF;

  FOR table_name IN
    SELECT DISTINCT class.relname
      FROM ingestion.fivetran_destination_bindings AS binding
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
      JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
     WHERE binding.retired_at IS NULL
       AND binding.destination_schema LIKE p_prefix || '\_%'
       AND class.relname NOT LIKE 'fivetran\_%'
       AND class.relname NOT LIKE '\_fivetran\_%'
  LOOP
    -- SDK-shaped tables carry the source prefix and Albert's contract names;
    -- only those get the letter<->digit alias collapse.
    sdk_shaped := table_name LIKE p_prefix || '\_%';

    SELECT binding.destination_schema INTO leader_schema
      FROM ingestion.fivetran_destination_bindings AS binding
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
      JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
     WHERE binding.retired_at IS NULL
       AND binding.destination_schema LIKE p_prefix || '\_%'
       AND class.relname = table_name
     ORDER BY binding.created_at DESC
     LIMIT 1;

    branches := ARRAY[]::text[];
    FOR active IN
      SELECT binding.destination_schema, binding.tenant_id
        FROM ingestion.fivetran_destination_bindings AS binding
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
        JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
       WHERE binding.retired_at IS NULL
         AND binding.destination_schema LIKE p_prefix || '\_%'
         AND class.relname = table_name
       ORDER BY binding.created_at DESC
    LOOP
      select_list := format('%L::text AS tenant_id', active.tenant_id);
      FOR column_rec IN
        SELECT attribute.attname AS name, format_type(attribute.atttypid, attribute.atttypmod) AS type
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = format('%I.%I', leader_schema, table_name)::regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attname NOT IN ('tenant_id')
         ORDER BY attribute.attnum
      LOOP
        alias_name := CASE WHEN sdk_shaped
          THEN regexp_replace(column_rec.name, '([a-z])_([0-9])', '\1\2', 'g')
          ELSE column_rec.name END;
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute AS other
           WHERE other.attrelid = format('%I.%I', active.destination_schema, table_name)::regclass
             AND other.attname = column_rec.name
             AND NOT other.attisdropped
        ) INTO present;
        IF present THEN
          select_list := select_list || format(', %I::%s AS %I', column_rec.name, column_rec.type, alias_name);
        ELSE
          select_list := select_list || format(', NULL::%s AS %I', column_rec.type, alias_name);
        END IF;
      END LOOP;
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS other
         WHERE other.attrelid = format('%I.%I', active.destination_schema, table_name)::regclass
           AND other.attname = 'source_record_id' AND NOT other.attisdropped
      ) THEN
        select_list := select_list || ', source_record_id::text AS namespaced_source_key';
      ELSE
        select_list := select_list || ', NULL::text AS namespaced_source_key';
      END IF;
      branch_sql := format('SELECT %s FROM %I.%I', select_list, active.destination_schema, table_name);
      branches := branches || branch_sql;
    END LOOP;

    IF array_length(branches, 1) IS NULL THEN
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s',
                     target_schema, table_name, array_to_string(branches, ' UNION ALL '));
      EXECUTE format('GRANT SELECT ON %I.%I TO transform_rw, diagnostic_ro', target_schema, table_name);
      rebuilt := rebuilt + 1;
    EXCEPTION
      WHEN feature_not_supported OR invalid_table_definition OR datatype_mismatch OR undefined_column THEN
        NULL;
    END;
  END LOOP;
  RETURN rebuilt;
END;
$$;

-- 2. Stamp every active binding, then build the Deputy union views --------------

DO $$
DECLARE binding record;
BEGIN
  FOR binding IN
    SELECT destination_schema, tenant_id FROM ingestion.fivetran_destination_bindings WHERE retired_at IS NULL
  LOOP
    PERFORM ingestion.stamp_fivetran_destination(binding.destination_schema, binding.tenant_id);
  END LOOP;
END $$;

SELECT ingestion.rebuild_fivetran_source_views('deputy');
SELECT ingestion.rebuild_fivetran_source_views('xero');

DO $$
BEGIN
  IF to_regclass('source_deputy_fivetran.resource_timesheet') IS NULL THEN
    RAISE EXCEPTION 'no active Fivetran Deputy schema carries resource_timesheet; connect one before repointing';
  END IF;
END $$;

-- 3. Leave-rule labels: operator-defined names with no Fivetran source ----------

CREATE TABLE IF NOT EXISTS source_deputy_fivetran.leave_rule_labels (
  leave_rule_id bigint PRIMARY KEY,
  rule_name text,
  paid_leave boolean,
  visible boolean,
  description text
);

DO $$
BEGIN
  IF to_regclass('"DEPUTYNEW".deputy_leaverules') IS NOT NULL THEN
    INSERT INTO source_deputy_fivetran.leave_rule_labels (leave_rule_id, rule_name, paid_leave, visible, description)
    SELECT "Id"::bigint, "Name", "PaidLeave", "Visible", "Description"
      FROM "DEPUTYNEW".deputy_leaverules
    ON CONFLICT (leave_rule_id) DO UPDATE
      SET rule_name = EXCLUDED.rule_name,
          paid_leave = EXCLUDED.paid_leave,
          visible = EXCLUDED.visible,
          description = EXCLUDED.description;
  END IF;
END $$;

GRANT SELECT ON source_deputy_fivetran.leave_rule_labels TO transform_rw, diagnostic_ro;

-- 4. dp_* views over the Fivetran surface (same output columns as 0134) ---------

DROP VIEW IF EXISTS source_deputy.dp_employees;
DROP VIEW IF EXISTS source_deputy.dp_employee_roles;
DROP VIEW IF EXISTS source_deputy.dp_operational_units;
DROP VIEW IF EXISTS source_deputy.dp_companies;
DROP VIEW IF EXISTS source_deputy.dp_timesheets;
DROP VIEW IF EXISTS source_deputy.dp_rosters;
DROP VIEW IF EXISTS source_deputy.dp_leave;
DROP VIEW IF EXISTS source_deputy.dp_leave_rules;

CREATE VIEW source_deputy.dp_employees
WITH (security_barrier = true) AS
SELECT
  e.tenant_id,
  e.tenant_id || ':' || e.id::text AS row_key,
  e.id                AS employee_id,
  h.first_name        AS first_name,
  h.last_name         AS last_name,
  h.display_name      AS display_name,
  h.position          AS position,
  h.active            AS active,
  NULL::boolean       AS paused,
  h.start_date        AS started_on,
  h.termination_date  AS terminated_on,
  h.company_id        AS company_id,
  h.role_id           AS role_id,
  e.created           AS created_at,
  e.modified          AS modified_at
FROM source_deputy_fivetran.employee e
LEFT JOIN source_deputy_fivetran.employee_history h
  ON h.tenant_id = e.tenant_id AND h.id = e.history_id
WHERE e.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(e._fivetran_deleted, false);

CREATE VIEW source_deputy.dp_employee_roles
WITH (security_barrier = true) AS
SELECT
  r.tenant_id,
  r.tenant_id || ':' || r.id::text AS row_key,
  r.id      AS role_id,
  r.role    AS role_name,
  r.ranking AS ranking
FROM source_deputy_fivetran.employee_role r
WHERE r.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(r._fivetran_deleted, false);

CREATE VIEW source_deputy.dp_operational_units
WITH (security_barrier = true) AS
SELECT
  u.tenant_id,
  u.tenant_id || ':' || u.id::text AS row_key,
  u.id                    AS operational_unit_id,
  u.operational_unit_name AS unit_name,
  u.company_id            AS company_id,
  c.company_name          AS company_name,
  u.active                AS active,
  a.city                  AS city,
  a.state                 AS state
FROM source_deputy_fivetran.operational_unit u
LEFT JOIN source_deputy_fivetran.company c
  ON c.tenant_id = u.tenant_id AND c.id = u.company_id
LEFT JOIN source_deputy_fivetran.address a
  ON a.tenant_id = u.tenant_id AND a.id = u.address_id
WHERE u.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(u._fivetran_deleted, false);

CREATE VIEW source_deputy.dp_companies
WITH (security_barrier = true) AS
SELECT
  c.tenant_id,
  c.tenant_id || ':' || c.id::text AS row_key,
  c.id                AS company_id,
  c.company_name      AS company_name,
  NULL::text          AS trading_name,
  c.active            AS active,
  c.is_workplace      AS is_workplace,
  c.is_payroll_entity AS is_payroll_entity
FROM source_deputy_fivetran.company c
WHERE c.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(c._fivetran_deleted, false);

CREATE VIEW source_deputy.dp_timesheets
WITH (security_barrier = true) AS
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.id::text AS row_key,
  t.id                  AS timesheet_id,
  t.employee_id         AS employee_id,
  h.display_name        AS employee_name,
  t.date                AS shift_date,
  t.start_time_localized AS started_at,
  t.end_time_localized  AS ended_at,
  t.total_time          AS paid_hours,
  t.cost                AS wage_cost,
  t.on_cost             AS loaded_cost,
  t.time_approved       AS time_approved,
  t.pay_rule_approved   AS pay_approved,
  t.is_in_progress      AS in_progress,
  t.is_leave            AS is_leave,
  t.leave_id            AS leave_id,
  t.leave_rule_id       AS leave_rule_id,
  t.operational_unit    AS operational_unit_id,
  u.operational_unit_name AS unit_name,
  c.company_name        AS company_name,
  t.roster_id           AS roster_id,
  t.employee_comment    AS employee_comment,
  t.created             AS created_at,
  t.modified            AS modified_at
FROM source_deputy_fivetran.resource_timesheet t
LEFT JOIN source_deputy_fivetran.employee e
  ON e.tenant_id = t.tenant_id AND e.id = t.employee_id
LEFT JOIN source_deputy_fivetran.employee_history h
  ON h.tenant_id = t.tenant_id AND h.id = e.history_id
LEFT JOIN source_deputy_fivetran.operational_unit u
  ON u.tenant_id = t.tenant_id AND u.id = t.operational_unit
LEFT JOIN source_deputy_fivetran.company c
  ON c.tenant_id = t.tenant_id AND c.id = u.company_id
WHERE t.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(t.discarded, false)
  AND NOT COALESCE(t._fivetran_deleted, false);

CREATE VIEW source_deputy.dp_rosters
WITH (security_barrier = true) AS
SELECT
  r.tenant_id,
  r.tenant_id || ':' || r.id::text AS row_key,
  r.id                  AS roster_id,
  r.employee_id         AS employee_id,
  h.display_name        AS employee_name,
  r.date                AS shift_date,
  r.start_time_localized AS starts_at,
  r.end_time_localized  AS ends_at,
  r.total_time          AS scheduled_hours,
  r.cost                AS scheduled_cost,
  r.published           AS published,
  r.opens               AS open_shift,
  r.matched_by_timesheet AS matched_timesheet_id,
  r.operational_unit_id AS operational_unit_id,
  u.operational_unit_name AS unit_name,
  c.company_name        AS company_name,
  r.comment             AS comment,
  r.confirm_status      AS confirm_status,
  r.created             AS created_at,
  r.modified            AS modified_at
FROM source_deputy_fivetran.roster r
LEFT JOIN source_deputy_fivetran.employee e
  ON e.tenant_id = r.tenant_id AND e.id = r.employee_id
LEFT JOIN source_deputy_fivetran.employee_history h
  ON h.tenant_id = r.tenant_id AND h.id = e.history_id
LEFT JOIN source_deputy_fivetran.operational_unit u
  ON u.tenant_id = r.tenant_id AND u.id = r.operational_unit_id
LEFT JOIN source_deputy_fivetran.company c
  ON c.tenant_id = r.tenant_id AND c.id = u.company_id
WHERE r.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(r._fivetran_deleted, false);

CREATE VIEW source_deputy.dp_leave
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
  l.modified       AS modified_at
FROM source_deputy_fivetran.employee_leave l
LEFT JOIN source_deputy_fivetran.employee e
  ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
LEFT JOIN source_deputy_fivetran.employee_history h
  ON h.tenant_id = l.tenant_id AND h.id = e.history_id
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(l._fivetran_deleted, false);

-- Leave-rule ids come from live Fivetran data; the operator-defined labels come
-- from the snapshot (Fivetran's Deputy connector carries no leave-rule table).
CREATE VIEW source_deputy.dp_leave_rules
WITH (security_barrier = true) AS
SELECT
  ids.tenant_id,
  ids.tenant_id || ':' || ids.leave_rule_id::text AS row_key,
  ids.leave_rule_id,
  COALESCE(labels.rule_name, 'Leave rule ' || ids.leave_rule_id::text) AS rule_name,
  labels.paid_leave,
  labels.visible,
  labels.description
FROM (
  SELECT DISTINCT tenant_id, leave_rule_id
    FROM (
      SELECT tenant_id, leave_rule_id FROM source_deputy_fivetran.employee_leave
      UNION ALL
      SELECT tenant_id, leave_rule_id FROM source_deputy_fivetran.resource_timesheet
    ) AS sources
   WHERE leave_rule_id IS NOT NULL
) AS ids
LEFT JOIN source_deputy_fivetran.leave_rule_labels labels
  ON labels.leave_rule_id = ids.leave_rule_id
WHERE ids.tenant_id = (SELECT ingestion.current_tenant_id());

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

-- 5. The duplicate double-fired schema, explicitly requested for deletion -------

DROP SCHEMA IF EXISTS deputy_01m07gdgdhd2ed2xxgq7rfh8zr CASCADE;

COMMIT;
