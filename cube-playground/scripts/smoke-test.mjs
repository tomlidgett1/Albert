#!/usr/bin/env node
/**
 * Smoke test for the Albert V3 Cube semantic layer.
 *
 * Signs a tenant-scoped JWT (same shape the v3 engine uses), pulls /v1/meta,
 * and runs a battery of representative queries against the curated views.
 *
 * Usage:
 *   node scripts/smoke-test.mjs                # run the battery
 *   node scripts/smoke-test.mjs --meta         # dump view/member catalogue
 *   node scripts/smoke-test.mjs --query '{"measures":["sales_analytics.gross_takings"]}'
 *
 * Env: CUBE_URL (default http://localhost:4000), TENANT_ID, CONVERSATION_ID,
 * TURN_ID override the defaults below. CUBEJS_API_SECRET is read from
 * cube-playground/.env when not set.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CUBE_URL = process.env.CUBE_URL || 'http://localhost:4000';

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

const envFile = readEnvFile(path.join(here, '..', '.env'));
const API_SECRET = process.env.CUBEJS_API_SECRET || envFile.CUBEJS_API_SECRET;
if (!API_SECRET) {
  console.error('CUBEJS_API_SECRET not found');
  process.exit(1);
}

const securityContext = {
  tenant_id: process.env.TENANT_ID || '01KZ4ZMVF5QNQ4TX35VF3WDJBM',
  conversation_id: process.env.CONVERSATION_ID || '01SM0KETESTC0NVAAAAAAAAAAA',
  turn_id: process.env.TURN_ID || '01SM0KETESTT0RNAAAAAAAAAAA',
};

function signJwt(payload, secret) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const token = signJwt(securityContext, API_SECRET);

async function cubeGet(pathname, params) {
  const url = new URL(pathname, CUBE_URL);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: token } });
  const json = await res.json();
  return { status: res.status, json };
}

async function load(query) {
  const started = Date.now();
  // Poll through "Continue wait" responses.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { status, json } = await cubeGet('/cubejs-api/v1/load', {
      query: JSON.stringify(query),
      queryType: 'multi',
    });
    if (json?.error === 'Continue wait') {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    return { status, json, elapsedMs: Date.now() - started };
  }
  return { status: 408, json: { error: 'timed out waiting for Cube' }, elapsedMs: Date.now() - started };
}

const battery = [
  {
    name: 'monthly gross takings (last 12 months)',
    query: {
      measures: ['sales_analytics.gross_takings', 'sales_analytics.transactions'],
      timeDimensions: [{ dimension: 'sales_analytics.completed_at', granularity: 'month', dateRange: 'last 12 months' }],
    },
  },
  {
    name: 'profitability summary',
    query: {
      measures: [
        'sales_analytics.net_sales_ex_tax',
        'sales_analytics.cost_of_goods',
        'sales_analytics.gross_profit',
        'sales_analytics.gross_margin_pct',
      ],
    },
  },
  {
    name: 'refunds by store',
    query: {
      measures: ['sales_analytics.refund_transactions', 'sales_analytics.refund_value'],
      dimensions: ['sales_analytics.shops_name'],
    },
  },
  {
    name: 'sale type split',
    query: {
      measures: ['sales_analytics.transactions'],
      dimensions: ['sales_analytics.sale_type'],
    },
  },
  {
    name: 'top 5 categories by line revenue',
    query: {
      measures: ['product_sales_analytics.line_revenue', 'product_sales_analytics.line_gross_profit'],
      dimensions: ['product_sales_analytics.categories_full_path_name'],
      order: { 'product_sales_analytics.line_revenue': 'desc' },
      limit: 5,
    },
  },
  {
    name: 'top 5 brands by units',
    query: {
      measures: ['product_sales_analytics.units_sold'],
      dimensions: ['product_sales_analytics.manufacturers_name'],
      order: { 'product_sales_analytics.units_sold': 'desc' },
      limit: 5,
    },
  },
  {
    name: 'payment mix',
    query: {
      measures: ['payments_analytics.tender_total', 'payments_analytics.payment_count'],
      dimensions: ['payments_analytics.payment_types_name'],
      order: { 'payments_analytics.tender_total': 'desc' },
    },
  },
  {
    name: 'customer base and repeat rate',
    query: {
      measures: [
        'customer_analytics.customer_count',
        'customer_analytics.customers_with_purchases',
        'customer_analytics.repeat_customers',
        'customer_analytics.repeat_purchase_rate_pct',
      ],
    },
  },
  {
    name: 'top 5 customers by lifetime revenue',
    query: {
      dimensions: ['customer_analytics.full_name', 'customer_analytics.lifetime_revenue', 'customer_analytics.lifetime_transactions'],
      order: { 'customer_analytics.lifetime_revenue': 'desc' },
      limit: 5,
    },
  },
  {
    name: 'quote conversion',
    query: {
      measures: ['sales_analytics.quotes_quote_count', 'sales_analytics.quotes_converted_quotes', 'sales_analytics.quotes_conversion_rate_pct'],
    },
  },
  {
    name: 'year over year month comparison (compareDateRange)',
    query: {
      measures: ['sales_analytics.gross_takings'],
      timeDimensions: [
        {
          dimension: 'sales_analytics.completed_at',
          compareDateRange: ['2025-07-01,2025-07-31', '2024-07-01,2024-07-31'],
        },
      ],
    },
  },
];

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--meta') {
    const { status, json } = await cubeGet('/cubejs-api/v1/meta', {});
    if (status !== 200) {
      console.error('meta failed', status, JSON.stringify(json).slice(0, 2000));
      process.exit(1);
    }
    for (const cube of json.cubes) {
      console.log(`\n=== ${cube.name} (public=${cube.public !== false}) ===`);
      console.log('  measures:', cube.measures.map((m) => m.name.split('.')[1]).join(', '));
      console.log('  dimensions:', cube.dimensions.map((d) => d.name.split('.')[1]).join(', '));
      if (cube.segments?.length) console.log('  segments:', cube.segments.map((s) => s.name.split('.')[1]).join(', '));
    }
    return;
  }

  if (args[0] === '--query') {
    const result = await load(JSON.parse(args[1]));
    console.log(JSON.stringify(result.json, null, 2).slice(0, 8000));
    return;
  }

  const meta = await cubeGet('/cubejs-api/v1/meta', {});
  if (meta.status !== 200) {
    console.error('META FAILED', meta.status, JSON.stringify(meta.json).slice(0, 3000));
    process.exit(1);
  }
  const publicCubes = meta.json.cubes.map((c) => c.name);
  console.log('meta OK. exposed cubes/views:', publicCubes.join(', '));

  let failures = 0;
  for (const test of battery) {
    const { status, json, elapsedMs } = await load(test.query);
    if (status === 200 && (json.data || json.results)) {
      const rows = json.data?.length ?? json.results?.map((r) => r.data?.length).join('+');
      console.log(`PASS  ${test.name}  rows=${rows}  ${elapsedMs}ms`);
      const sample = json.data?.[0] ?? json.results?.[0]?.data?.[0];
      if (sample) console.log('      sample:', JSON.stringify(sample).slice(0, 300));
    } else {
      failures += 1;
      console.log(`FAIL  ${test.name}  status=${status}`);
      console.log('      error:', JSON.stringify(json.error || json).slice(0, 600));
    }
  }
  console.log(failures === 0 ? '\nAll battery queries passed.' : `\n${failures} battery queries failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
