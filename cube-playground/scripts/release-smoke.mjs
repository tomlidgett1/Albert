#!/usr/bin/env node
/**
 * Authenticated production-release proof executed inside the exact Cube image.
 *
 * The release runner supplies only an opaque, short-lived semantic turn. The
 * Cube signing secret never leaves the Machine, and this process never emits
 * response rows, JWTs, tenant/turn identifiers, or response bodies. Its sole
 * stdout record is a bounded structural proof consumed by the release runner.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PROOF_MARKER = 'ALBERT_CUBE_RELEASE_PROOF:';
const CUBE_ORIGIN = 'http://127.0.0.1:4000';
const VIEW = 'shopify_sales_analytics';
const MEASURES = Object.freeze([
  `${VIEW}.current_total_sales`,
  `${VIEW}.orders`,
  `${VIEW}.distinct_protected_subjects`,
]);
const TIME_DIMENSION = `${VIEW}.processed_at`;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const MAX_META_BYTES = 64 * 1024 * 1024;
const MAX_LOAD_BYTES = 128 * 1024;

class SafeSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SafeSmokeError';
    this.code = code;
  }
}

function fail(code) {
  throw new SafeSmokeError(code);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signJwt(context, secret, now = new Date()) {
  if (!context || !ULID_PATTERN.test(context.tenant_id ?? '') ||
      !ULID_PATTERN.test(context.conversation_id ?? '') ||
      !ULID_PATTERN.test(context.turn_id ?? '')) {
    fail('invalid_turn_context');
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    fail('missing_cube_signing_secret');
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAt)) fail('invalid_clock');
  const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64urlJson({
    ...context,
    albert_release_smoke: true,
    scope: ['meta', 'data'],
    iat: issuedAt,
    exp: issuedAt + 120,
  });
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function createFutureWindow(now = new Date()) {
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) fail('invalid_clock');
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + 2);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return Object.freeze([
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  ]);
}

export function buildShopifyQuery(now = new Date()) {
  return Object.freeze({
    measures: MEASURES,
    timeDimensions: Object.freeze([Object.freeze({
      dimension: TIME_DIMENSION,
      granularity: 'day',
      dateRange: createFutureWindow(now),
    })]),
    timezone: 'Australia/Melbourne',
    limit: 1,
  });
}

function memberNames(members) {
  if (!Array.isArray(members)) return new Set();
  return new Set(members.map((member) => member?.name).filter((name) => typeof name === 'string'));
}

export function validateMetaResponse(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cubes)) {
    fail('meta_shape_invalid');
  }
  const matches = payload.cubes.filter((cube) => cube?.name === VIEW);
  if (matches.length !== 1) fail('shopify_view_missing');
  const view = matches[0];
  const meta = view.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
      meta.privacy_policy !== 'aggregate_only' ||
      meta.minimum_time_granularity !== 'day' ||
      meta.privacy_minimum_group_size !== 5 ||
      meta.privacy_population_measure !== 'distinct_protected_subjects') {
    fail('shopify_privacy_policy_invalid');
  }
  const measures = memberNames(view.measures);
  const dimensions = memberNames(view.dimensions);
  if (MEASURES.some((member) => !measures.has(member)) || !dimensions.has(TIME_DIMENSION)) {
    fail('shopify_members_missing');
  }
  return Object.freeze({
    view: VIEW,
    privacyPolicy: 'aggregate_only',
    minimumTimeGranularity: 'day',
    privacyMinimumGroupSize: 5,
    privacyPopulationMeasure: 'distinct_protected_subjects',
    measures: MEASURES,
    timeDimension: TIME_DIMENSION,
  });
}

export function validateLoadResponse(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    fail('load_shape_invalid');
  }
  if (payload.data.length !== 0) fail('future_window_not_empty');
  return Object.freeze({
    measures: MEASURES,
    timeDimension: TIME_DIMENSION,
    granularity: 'day',
    emptyFutureWindow: true,
    rowCount: 0,
  });
}

async function boundedJson(response, maximumBytes, failureCode) {
  if (!response.body) fail(failureCode);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) fail(`${failureCode}_too_large`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    fail(failureCode);
  }
}

async function cubeRequest(pathname, token, body, maximumBytes) {
  const response = await fetch(new URL(pathname, CUBE_ORIGIN), {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: token,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
  }).catch(() => fail('cube_request_failed'));
  const payload = await boundedJson(response, maximumBytes, 'cube_response_invalid');
  if (response.status !== 200) fail(pathname.endsWith('/meta') ? 'meta_http_failed' : 'load_http_failed');
  return payload;
}

async function loadUntilReady(token, query) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const payload = await cubeRequest(
      '/cubejs-api/v1/load',
      token,
      { query },
      MAX_LOAD_BYTES,
    );
    if (payload?.error !== 'Continue wait') return payload;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail('load_wait_timeout');
}

function decodeContext(argument) {
  if (typeof argument !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/u.test(argument)) {
    fail('invalid_turn_context');
  }
  let context;
  try {
    context = JSON.parse(Buffer.from(argument, 'base64url').toString('utf8'));
  } catch {
    fail('invalid_turn_context');
  }
  exactKeys(context, ['tenant_id', 'conversation_id', 'turn_id'], 'invalid_turn_context');
  return context;
}

function structurallyEqual(left, right) {
  const a = Buffer.from(JSON.stringify(left));
  const b = Buffer.from(JSON.stringify(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function runSmoke({ encodedContext, secret, now = new Date() }) {
  const context = decodeContext(encodedContext);
  const token = signJwt(context, secret, now);
  const meta = validateMetaResponse(await cubeRequest(
    '/cubejs-api/v1/meta',
    token,
    null,
    MAX_META_BYTES,
  ));
  const query = buildShopifyQuery(now);
  const load = validateLoadResponse(await loadUntilReady(token, query));
  if (!structurallyEqual(query.measures, load.measures) ||
      query.timeDimensions[0].dimension !== load.timeDimension ||
      query.timeDimensions[0].granularity !== load.granularity) {
    fail('query_proof_mismatch');
  }
  return Object.freeze({ schemaVersion: 1, ok: true, meta, query: load });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const proof = await runSmoke({
      encodedContext: process.argv[2],
      secret: process.env.CUBEJS_API_SECRET,
    });
    process.stdout.write(`${PROOF_MARKER}${JSON.stringify(proof)}\n`);
  } catch (error) {
    const code = error instanceof SafeSmokeError ? error.code : 'unexpected_failure';
    process.stdout.write(`${PROOF_MARKER}${JSON.stringify({ schemaVersion: 1, ok: false, errorCode: code })}\n`);
    process.exitCode = 1;
  }
}
