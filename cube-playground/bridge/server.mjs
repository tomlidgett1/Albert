/**
 * Local Cubecore warehouse bridge.
 *
 * Albert's vinext/Cloudflare web runtime cannot keep a stable `pg` TCP session
 * to Supabase (fails with "Connection terminated unexpectedly"). This tiny Node
 * process owns the capability + semantic_ro query path and exposes it over HTTP
 * so `/api/cube-conversation` can `fetch` it.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CUBECORE_BRIDGE_PORT || 4010);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.resolve(__dirname, "../../.env.local"));
loadEnvFile(path.resolve(__dirname, "../.env"));

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function semanticReadDatabaseUrl() {
  return process.env.ALBERT_SEMANTIC_READ_DATABASE_URL?.trim()
    || requiredEnv("ANALYTICAL_DATABASE_URL");
}

async function withClient(connectionString, run) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 5_000,
    application_name: "albert-cubecore-bridge",
  });
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

async function issueCapability({ tenantId, conversationId, turnId }) {
  const controlUrl = process.env.ALBERT_SEMANTIC_CONTROL_DATABASE_URL?.trim()
    || process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (!controlUrl) throw new Error("Control-plane database URL is not configured.");

  return withClient(controlUrl, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE albert_semantic_control");
      const result = await client.query(
        `SELECT control_plane.issue_semantic_analytical_capability(
           $1::text, $2::text, $3::text, 'semantic_read'::text
         ) AS capability`,
        [tenantId, conversationId, turnId],
      );
      const capability = result.rows[0]?.capability;
      if (typeof capability !== "string" || capability.length < 100 || capability.length > 4096) {
        throw new Error("Control plane returned an invalid analytical capability.");
      }
      await client.query("COMMIT");
      return capability;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original */ }
      throw error;
    }
  });
}

function mapRow(row) {
  const first = typeof row.first_name === "string" ? row.first_name : "";
  const last = typeof row.last_name === "string" ? row.last_name : "";
  const company = typeof row.company === "string" ? row.company : "";
  const fullName = [first, last].filter(Boolean).join(" ").trim() || company || String(row.customer_id ?? "");
  return {
    "customers.customer_id": row.customer_id == null ? null : String(row.customer_id),
    "customers.full_name": fullName || null,
    "customers.company": company || null,
    "customers.customer_type_id": row.customer_type_id == null ? null : String(row.customer_type_id),
    "customers.create_time": row.create_time ?? null,
    "customers.count": row.count == null ? null : String(row.count),
    "customers.active_customers": row.active_customers == null ? null : String(row.active_customers),
    "customers.unique_customers": row.unique_customers == null ? null : String(row.unique_customers),
    "customers.company_customers": row.company_customers == null ? null : String(row.company_customers),
  };
}

async function loadCustomers(body) {
  const tenantId = String(body.tenantId || "");
  const conversationId = String(body.conversationId || "");
  const turnId = String(body.turnId || "");
  const kind = body.kind === "count_customers" ? "count_customers" : "list_customers";
  const name = typeof body.nameFilter === "string" && body.nameFilter.trim()
    ? body.nameFilter.trim()
    : null;

  if (!tenantId || !conversationId || !turnId) {
    throw new Error("tenantId, conversationId, and turnId are required.");
  }

  const capability = await issueCapability({ tenantId, conversationId, turnId });
  return withClient(semanticReadDatabaseUrl(), async (client) => {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await client.query("SET LOCAL ROLE semantic_ro");
      await client.query("SELECT set_config('albert.tenant_capability', $1, true)", [capability]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", ["15000ms"]);
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [tenantId],
      );

      // "called Tom" → first_name starts with Tom (not last names like Tomaselli).
      const nameClause = `
        ($1::text IS NULL OR first_name ILIKE $1 || '%')
      `;

      if (kind === "count_customers") {
        const result = await client.query(
          `SELECT
             count(*)::int AS count,
             count(*) FILTER (
               WHERE NOT COALESCE(tombstone, false) AND COALESCE(archived, false) = false
             )::int AS active_customers,
             count(DISTINCT customer_id) FILTER (
               WHERE NOT COALESCE(tombstone, false) AND COALESCE(archived, false) = false
             )::int AS unique_customers,
             count(*) FILTER (
               WHERE NOT COALESCE(tombstone, false)
                 AND COALESCE(archived, false) = false
                 AND NULLIF(TRIM(company), '') IS NOT NULL
             )::int AS company_customers
           FROM source_lightspeed.ls_customers
           WHERE NOT COALESCE(tombstone, false)
             AND COALESCE(archived, false) = false
             AND ${nameClause}`,
          [name],
        );
        await client.query("COMMIT");
        return { data: [mapRow(result.rows[0] ?? {})] };
      }

      const limit = name ? 50 : 25;
      const counted = await client.query(
        `SELECT count(*)::int AS n
         FROM source_lightspeed.ls_customers
         WHERE NOT COALESCE(tombstone, false)
           AND COALESCE(archived, false) = false
           AND ${nameClause}`,
        [name],
      );
      const totalMatches = Number(counted.rows[0]?.n ?? 0);
      const result = await client.query(
        `SELECT
           customer_id,
           first_name,
           last_name,
           company,
           customer_type_id,
           create_time
         FROM source_lightspeed.ls_customers
         WHERE NOT COALESCE(tombstone, false)
           AND COALESCE(archived, false) = false
           AND ${nameClause}
         ORDER BY create_time DESC NULLS LAST
         LIMIT $2`,
        [name, limit],
      );
      await client.query("COMMIT");
      return {
        data: result.rows.map((row) => mapRow(row)),
        totalMatches,
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original */ }
      throw error;
    }
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function timePredicate(alias, preset) {
  const col = `${alias}.complete_time`;
  switch (preset) {
    case "today":
      return `(${col} AT TIME ZONE 'Australia/Melbourne')::date = (now() AT TIME ZONE 'Australia/Melbourne')::date`;
    case "yesterday":
      return `(${col} AT TIME ZONE 'Australia/Melbourne')::date = ((now() AT TIME ZONE 'Australia/Melbourne')::date - 1)`;
    case "last_7_days":
      return `${col} >= ((now() AT TIME ZONE 'Australia/Melbourne')::date - 7)`;
    case "this_month":
      return `date_trunc('month', ${col} AT TIME ZONE 'Australia/Melbourne') = date_trunc('month', now() AT TIME ZONE 'Australia/Melbourne')`;
    case "last_month":
      return `date_trunc('month', ${col} AT TIME ZONE 'Australia/Melbourne') = date_trunc('month', now() AT TIME ZONE 'Australia/Melbourne') - interval '1 month'`;
    case "last_90_days":
      return `${col} >= ((now() AT TIME ZONE 'Australia/Melbourne')::date - 90)`;
    case "all_time":
      return "true";
    case "last_30_days":
    default:
      return `${col} >= ((now() AT TIME ZONE 'Australia/Melbourne')::date - 30)`;
  }
}

const SALE_GATE = `s.completed = true AND COALESCE(s.voided, false) = false AND COALESCE(s.tombstone, false) = false`;

async function loadAnalytics(body) {
  const tenantId = String(body.tenantId || "");
  const conversationId = String(body.conversationId || "");
  const turnId = String(body.turnId || "");
  const intent = String(body.intent || "gross_takings");
  const timePreset = String(body.timePreset || "last_30_days");
  const groupBy = String(body.groupBy || "none");
  const name = typeof body.nameFilter === "string" && body.nameFilter.trim()
    ? body.nameFilter.trim()
    : null;
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 100);

  if (!tenantId || !conversationId || !turnId) {
    throw new Error("tenantId, conversationId, and turnId are required.");
  }

  const capability = await issueCapability({ tenantId, conversationId, turnId });
  return withClient(semanticReadDatabaseUrl(), async (client) => {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await client.query("SET LOCAL ROLE semantic_ro");
      await client.query("SELECT set_config('albert.tenant_capability', $1, true)", [capability]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", ["20000ms"]);
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [tenantId],
      );

      // Newest / last customer joined to their sale
      if (intent === "recent_customer_sale") {
        const saleFirst = String(body.lookupMode || "") === "last_sale";
        // Default: newest customer by create_time, plus their latest completed sale.
        // last_sale: latest completed sale that has a customer attached.
        const sql = saleFirst
          ? `
            SELECT
              c.customer_id::text AS customer_id,
              NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS full_name,
              c.company,
              c.create_time AS customer_created_at,
              s.sale_id::text AS sale_id,
              s.complete_time,
              COALESCE(s.calc_total, 0)::float8 AS sale_total_inc_gst,
              COALESCE(s.calc_subtotal, 0)::float8 AS sale_total_ex_gst,
              COALESCE(sh.name, s.shop_id::text) AS shop_name,
              NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), '') AS employee_name
            FROM source_lightspeed.ls_sales s
            JOIN source_lightspeed.ls_customers c ON c.customer_id = s.customer_id
            LEFT JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
            LEFT JOIN source_lightspeed.ls_employees e ON e.employee_id = s.employee_id
            WHERE ${SALE_GATE}
              AND s.customer_id IS NOT NULL
              AND COALESCE(c.tombstone, false) = false
              AND COALESCE(c.archived, false) = false
            ORDER BY s.complete_time DESC NULLS LAST
            LIMIT 1`
          : `
            SELECT
              c.customer_id::text AS customer_id,
              NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS full_name,
              c.company,
              c.create_time AS customer_created_at,
              s.sale_id::text AS sale_id,
              s.complete_time,
              COALESCE(s.calc_total, 0)::float8 AS sale_total_inc_gst,
              COALESCE(s.calc_subtotal, 0)::float8 AS sale_total_ex_gst,
              COALESCE(sh.name, s.shop_id::text) AS shop_name,
              NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), '') AS employee_name
            FROM source_lightspeed.ls_customers c
            LEFT JOIN LATERAL (
              SELECT s.*
              FROM source_lightspeed.ls_sales s
              WHERE s.customer_id = c.customer_id
                AND ${SALE_GATE}
              ORDER BY s.complete_time DESC NULLS LAST
              LIMIT 1
            ) s ON true
            LEFT JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
            LEFT JOIN source_lightspeed.ls_employees e ON e.employee_id = s.employee_id
            WHERE COALESCE(c.tombstone, false) = false
              AND COALESCE(c.archived, false) = false
            ORDER BY c.create_time DESC NULLS LAST
            LIMIT 1`;
        const result = await client.query(sql);
        await client.query("COMMIT");
        return { data: result.rows, sql };
      }

      // Customer intents
      if (intent === "list_customers" || intent === "count_customers") {
        const nameClause = `($1::text IS NULL OR first_name ILIKE $1 || '%')`;
        if (intent === "count_customers") {
          const result = await client.query(
            `SELECT count(*)::int AS customer_count, count(*)::int AS count
             FROM source_lightspeed.ls_customers
             WHERE NOT COALESCE(tombstone, false)
               AND COALESCE(archived, false) = false
               AND ${nameClause}`,
            [name],
          );
          await client.query("COMMIT");
          return { data: result.rows, sql: "count ls_customers" };
        }
        const counted = await client.query(
          `SELECT count(*)::int AS n FROM source_lightspeed.ls_customers
           WHERE NOT COALESCE(tombstone, false) AND COALESCE(archived, false) = false AND ${nameClause}`,
          [name],
        );
        const result = await client.query(
          `SELECT customer_id::text AS customer_id,
                  NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS full_name,
                  company
           FROM source_lightspeed.ls_customers
           WHERE NOT COALESCE(tombstone, false) AND COALESCE(archived, false) = false AND ${nameClause}
           ORDER BY create_time DESC NULLS LAST
           LIMIT $2`,
          [name, limit],
        );
        await client.query("COMMIT");
        return {
          data: result.rows,
          totalMatches: Number(counted.rows[0]?.n ?? 0),
          sql: "list ls_customers",
        };
      }

      const timeSql = timePredicate("s", timePreset);

      if (intent === "tenders" || groupBy === "payment_type") {
        const sql = `
          SELECT COALESCE(pt.name, 'Unknown') AS label,
                 SUM(COALESCE(p.amount, 0) - COALESCE(p.tip_amount, 0))::float8 AS merchandise_tender,
                 SUM(COALESCE(p.amount, 0))::float8 AS tender_amount,
                 SUM(COALESCE(p.amount, 0))::float8 AS metric_primary,
                 COUNT(*)::int AS transactions
          FROM source_lightspeed.ls_sale_payments p
          JOIN source_lightspeed.ls_sales s ON s.sale_id = p.sale_id
          LEFT JOIN source_lightspeed.ls_payment_types pt ON pt.payment_type_id = p.payment_type_id
          WHERE ${SALE_GATE}
            AND COALESCE(p.archived, false) = false
            AND COALESCE(p.tombstone, false) = false
            AND ${timeSql}
          GROUP BY 1
          ORDER BY tender_amount DESC NULLS LAST
          LIMIT $1`;
        const result = await client.query(sql, [limit]);
        await client.query("COMMIT");
        return { data: result.rows, sql };
      }

      if (intent === "top_products" || groupBy === "item") {
        const sql = `
          SELECT COALESCE(l.item_id::text, 'Unknown') AS label,
                 SUM(COALESCE(l.unit_quantity, 0))::float8 AS units_sold,
                 SUM(COALESCE(l.calc_total, 0))::float8 AS gross_takings_inc_gst,
                 SUM(COALESCE(l.calc_total, 0))::float8 AS metric_primary,
                 COUNT(DISTINCT l.sale_id)::int AS transactions
          FROM source_lightspeed.ls_sale_lines l
          JOIN source_lightspeed.ls_sales s ON s.sale_id = l.sale_id
          WHERE ${SALE_GATE}
            AND COALESCE(l.tombstone, false) = false
            AND l.item_fee_id IS NULL
            AND ${timeSql}
          GROUP BY 1
          ORDER BY units_sold DESC NULLS LAST
          LIMIT $1`;
        const result = await client.query(sql, [limit]);
        await client.query("COMMIT");
        return { data: result.rows, sql };
      }

      if (groupBy === "shop" || groupBy === "employee" || groupBy === "day" || intent === "staff_performance") {
        const labelExpr = groupBy === "shop"
          ? "COALESCE(sh.name, s.shop_id::text, 'Unknown')"
          : groupBy === "day"
            ? "to_char((s.complete_time AT TIME ZONE 'Australia/Melbourne')::date, 'YYYY-MM-DD')"
            : "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''), s.employee_id::text, 'Unassigned')";
        const joinExtra = groupBy === "shop"
          ? "LEFT JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id"
          : (groupBy === "employee" || intent === "staff_performance")
            ? "LEFT JOIN source_lightspeed.ls_employees e ON e.employee_id = s.employee_id"
            : "";
        const employeeFilter = (groupBy === "employee" || intent === "staff_performance")
          ? "AND COALESCE(s.employee_id, 0) <> 0"
          : "";
        const sql = `
          SELECT ${labelExpr} AS label,
                 SUM(COALESCE(s.calc_total, 0))::float8 AS gross_takings_inc_gst,
                 COUNT(DISTINCT s.sale_id)::int AS transactions,
                 (SUM(COALESCE(s.calc_total, 0)) / NULLIF(COUNT(DISTINCT s.sale_id), 0))::float8 AS aov,
                 SUM(COALESCE(s.calc_total, 0))::float8 AS metric_primary
          FROM source_lightspeed.ls_sales s
          ${joinExtra}
          WHERE ${SALE_GATE}
            AND ${timeSql}
            ${employeeFilter}
          GROUP BY 1
          ORDER BY gross_takings_inc_gst DESC NULLS LAST
          LIMIT $1`;
        const result = await client.query(sql, [limit]);
        await client.query("COMMIT");
        return { data: result.rows, sql };
      }

      // Scalar sales summary
      const sql = `
        SELECT
          SUM(COALESCE(s.calc_total, 0))::float8 AS gross_takings_inc_gst,
          SUM(COALESCE(s.calc_subtotal, 0))::float8 AS net_sales_ex_gst,
          COUNT(DISTINCT s.sale_id)::int AS transactions,
          (SUM(COALESCE(s.calc_total, 0)) / NULLIF(COUNT(DISTINCT s.sale_id), 0))::float8 AS aov,
          SUM(COALESCE(s.calc_discount, 0))::float8 AS discount_amount,
          SUM(COALESCE(s.calc_tax1, 0) + COALESCE(s.calc_tax2, 0))::float8 AS tax_collected,
          SUM(CASE WHEN s.calc_total < 0 THEN ABS(s.calc_total) ELSE 0 END)::float8 AS refund_amount
        FROM source_lightspeed.ls_sales s
        WHERE ${SALE_GATE}
          AND ${timeSql}`;
      const result = await client.query(sql);
      if (intent === "units") {
        const units = await client.query(`
          SELECT SUM(COALESCE(l.unit_quantity, 0))::float8 AS units_sold
          FROM source_lightspeed.ls_sale_lines l
          JOIN source_lightspeed.ls_sales s ON s.sale_id = l.sale_id
          WHERE ${SALE_GATE}
            AND COALESCE(l.tombstone, false) = false
            AND l.item_fee_id IS NULL
            AND ${timeSql}`);
        result.rows[0] = {
          ...(result.rows[0] || {}),
          units_sold: units.rows[0]?.units_sold ?? 0,
        };
      }
      await client.query("COMMIT");
      return { data: result.rows, sql };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original */ }
      throw error;
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/customers") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const result = await loadCustomers(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        data: [],
        error: error instanceof Error ? error.message : "Bridge customer load failed.",
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/v1/analytics") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const result = await loadAnalytics(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        data: [],
        error: error instanceof Error ? error.message : "Bridge analytics load failed.",
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[cubecore-bridge] listening on http://127.0.0.1:${PORT}`);
});
