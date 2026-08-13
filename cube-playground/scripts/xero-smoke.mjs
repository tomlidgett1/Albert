#!/usr/bin/env node
/** Xero semantic layer smoke battery: prints data rows only.
 * Usage: node scripts/xero-smoke.mjs ['{"measures":[...]}']
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CUBE_URL = process.env.CUBE_URL || 'http://localhost:4000';

const envFile = Object.fromEntries(
  fs.readFileSync(path.join(here, '..', '.env'), 'utf8').split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
);
const secret = process.env.CUBEJS_API_SECRET || envFile.CUBEJS_API_SECRET;

const ctx = {
  tenant_id: process.env.TENANT_ID || '01KZ4ZMVF5QNQ4TX35VF3WDJBM',
  conversation_id: '01SM0KETESTC0NVAAAAAAAAAAA',
  turn_id: '01SM0KETESTT0RNAAAAAAAAAAA',
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({ ...ctx, exp: Math.floor(Date.now() / 1000) + 3600 });
const token = `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;

async function load(query) {
  for (let i = 0; i < 90; i++) {
    const url = new URL('/cubejs-api/v1/load', CUBE_URL);
    url.searchParams.set('query', JSON.stringify(query));
    const res = await fetch(url, { headers: { Authorization: token } });
    const j = await res.json();
    if (j?.error === 'Continue wait') { await new Promise((r) => setTimeout(r, 1000)); continue; }
    return { status: res.status, j };
  }
  return { status: 408, j: { error: 'timeout' } };
}

const battery = process.argv[2]
  ? [['ad-hoc', JSON.parse(process.argv[2])]]
  : [];

for (const [name, q] of battery) {
  const { status, j } = await load(q);
  const data = j.data ?? (j.results ? j.results[0]?.data : undefined);
  if (status === 200 && data) {
    console.log(`PASS ${name} rows=${data.length}`);
    for (const row of data.slice(0, 8)) console.log('  ', JSON.stringify(row));
  } else {
    console.log(`FAIL ${name} status=${status} ${JSON.stringify(j.error ?? j).slice(0, 400)}`);
  }
}
