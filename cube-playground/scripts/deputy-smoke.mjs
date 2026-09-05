#!/usr/bin/env node
/** Deputy workforce_analytics smoke battery: prints data rows only. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CUBE_URL = process.env.CUBE_URL || 'http://localhost:4000';
const envFile = Object.fromEntries(
  fs.readFileSync(path.join(here, '..', '.env'), 'utf8').split('\n')
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
);
const API_SECRET = process.env.CUBEJS_API_SECRET || envFile.CUBEJS_API_SECRET;
const ctx = {
  tenant_id: '01KZ4ZMVF5QNQ4TX35VF3WDJBM',
  conversation_id: '01SM0KETESTC0NVAAAAAAAAAAA',
  turn_id: '01SM0KETESTT0RNAAAAAAAAAAA',
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({ ...ctx, exp: Math.floor(Date.now() / 1000) + 3600 });
const token = `${head}.${body}.${crypto.createHmac('sha256', API_SECRET).update(`${head}.${body}`).digest('base64url')}`;

async function load(query) {
  for (let i = 0; i < 60; i += 1) {
    const url = new URL('/cubejs-api/v1/load', CUBE_URL);
    url.searchParams.set('query', JSON.stringify(query));
    const res = await fetch(url, { headers: { Authorization: token } });
    const json = await res.json();
    if (json?.error === 'Continue wait') { await new Promise((r) => setTimeout(r, 1000)); continue; }
    return { status: res.status, json };
  }
  return { status: 408, json: { error: 'timeout' } };
}

const battery = [
  ['hours + wage cost by staff, this year', {
    measures: ['workforce_analytics.hours_worked', 'workforce_analytics.wage_cost'],
    dimensions: ['workforce_analytics.worked_by'],
    timeDimensions: [{ dimension: 'workforce_analytics.shift_date', dateRange: 'this year' }],
    order: { 'workforce_analytics.hours_worked': 'desc' },
    limit: 6,
  }],
  ['weekly hours for Leigh Phillips this year', {
    measures: ['workforce_analytics.hours_worked'],
    filters: [{ member: 'workforce_analytics.worked_by', operator: 'contains', values: ['leigh'] }],
    timeDimensions: [{ dimension: 'workforce_analytics.shift_date', granularity: 'week', dateRange: 'this year' }],
    order: { 'workforce_analytics.hours_worked': 'desc' },
    limit: 3,
  }],
  ['rostered hours + cost by area, last month', {
    measures: ['workforce_analytics.rostered_shift_count', 'workforce_analytics.rostered_hours', 'workforce_analytics.rostered_cost'],
    dimensions: ['workforce_analytics.rostered_area'],
    timeDimensions: [{ dimension: 'workforce_analytics.rostered_date', dateRange: 'last month' }],
  }],
  ['leave by type and status, this year', {
    measures: ['workforce_analytics.leave_request_count', 'workforce_analytics.leave_days'],
    dimensions: ['workforce_analytics.leave_type', 'workforce_analytics.leave_status'],
    timeDimensions: [{ dimension: 'workforce_analytics.leave_starts', dateRange: 'this year' }],
  }],
  ['staff headcount', {
    measures: ['workforce_analytics.staff_count', 'workforce_analytics.active_staff_count'],
  }],
  ['staff list with position', {
    dimensions: ['workforce_analytics.staff_name', 'workforce_analytics.staff_position', 'workforce_analytics.staff_active'],
    filters: [{ member: 'workforce_analytics.staff_active', operator: 'equals', values: ['true'] }],
  }],
  ['on shift right now', {
    measures: ['workforce_analytics.on_shift_now_count'],
  }],
  ['cross-tool sanity: lightspeed sales by staff, this year', {
    measures: ['sales_analytics.gross_takings'],
    dimensions: ['sales_analytics.employees_full_name'],
    timeDimensions: [{ dimension: 'sales_analytics.completed_at', dateRange: 'this year' }],
    order: { 'sales_analytics.gross_takings': 'desc' },
    limit: 5,
  }],
];

let failures = 0;
for (const [name, query] of battery) {
  const { status, json } = await load(query);
  if (status === 200 && json.data) {
    console.log(`PASS  ${name}  rows=${json.data.length}`);
    for (const row of json.data.slice(0, 6)) console.log('     ', JSON.stringify(row));
  } else {
    failures += 1;
    console.log(`FAIL  ${name}  status=${status}`);
    console.log('     ', JSON.stringify(json.error || json).slice(0, 500));
  }
}
process.exit(failures ? 1 : 0);
