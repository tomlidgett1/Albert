#!/usr/bin/env node
/**
 * Production release-side Cube proof coordinator.
 *
 * This process uses the exact operator-diagnostic login in the production
 * control cell to mint one existing three-minute semantic turn, asks the exact
 * Fly Machine to run its baked-in smoke probe, and then closes the turn with a
 * digest of the release-bound structural proof. It never reads or receives the
 * Cube signing secret and never writes customer rows or tenant identifiers to
 * the proof artifact.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);
const PROOF_MARKER = 'ALBERT_CUBE_RELEASE_PROOF:';
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const IMAGE_PATTERN = /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.\/-]+@sha256:[a-f0-9]{64}$/u;
const DEPLOYMENT_PATTERN = /^[1-9][0-9]{0,19}-(?:[1-9][0-9]{0,3}|10000)$/u;
const APP_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const MACHINE_PATTERN = /^[a-f0-9]{14,32}$/u;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const EXPECTED_SESSION_USER = 'albert_operator_diagnostic_control_runtime';
const EXPECTED_ROLE = 'albert_operator_diagnostic_control';

class SafeReleaseSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SafeReleaseSmokeError';
    this.code = code;
  }
}

function fail(code) {
  throw new SafeReleaseSmokeError(code);
}

/** @param {Readonly<Record<string, string | undefined>>} source */
function required(source, name) {
  const value = source[name]?.trim();
  if (!value) fail('configuration_missing');
  return value;
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), code);
}

function sha256(value) {
  return createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  ).digest('hex');
}

function safeFailureCode(error) {
  return error instanceof SafeReleaseSmokeError ? error.code : 'unexpected_failure';
}

export function productionDatabaseUrl(value, expectedProjectRef) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('control_database_url_invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail('control_database_url_invalid');
  }
  const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
  if (!['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    fail('control_database_tls_required');
  }
  if (!PROJECT_REF_PATTERN.test(expectedProjectRef)) {
    fail('control_database_cell_invalid');
  }
  let username;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    fail('control_database_url_invalid');
  }
  const directCell = parsed.hostname === `db.${expectedProjectRef}.supabase.co`;
  const pooledCell = /^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(parsed.hostname) &&
    username.endsWith(`.${expectedProjectRef}`);
  if (!directCell && !pooledCell) {
    fail('control_database_cell_invalid');
  }
  return value;
}

/** @param {Readonly<Record<string, string | undefined>>} [source] */
export function loadConfiguration(source = process.env) {
  const candidateSha = required(source, 'ALBERT_RELEASE_CANDIDATE_SHA');
  const runId = required(source, 'GITHUB_RUN_ID');
  const runAttempt = Number(required(source, 'GITHUB_RUN_ATTEMPT'));
  const deploymentId = required(source, 'ALBERT_RELEASE_DEPLOYMENT_ID');
  const cubeImage = required(source, 'ALBERT_RELEASE_CUBE_IMAGE');
  const authorizationDigest = required(source, 'ALBERT_RELEASE_AUTHORIZATION_DIGEST');
  const tenantId = required(source, 'ALBERT_RELEASE_CUBE_SMOKE_TENANT_ID');
  const appName = required(source, 'ALBERT_RELEASE_CUBE_APP');
  const machineId = required(source, 'ALBERT_RELEASE_CUBE_MACHINE_ID');
  const controlPlaneProjectRef = required(source, 'ALBERT_RELEASE_CONTROL_PLANE_PROJECT_REF');
  const databaseUrl = productionDatabaseUrl(
    required(source, 'ALBERT_RELEASE_CUBE_SMOKE_CONTROL_DATABASE_URL'),
    controlPlaneProjectRef,
  );
  if (!SHA_PATTERN.test(candidateSha) || !/^[1-9][0-9]{0,19}$/u.test(runId) ||
      !Number.isInteger(runAttempt) || runAttempt < 1 || runAttempt > 10_000 ||
      deploymentId !== `${runId}-${runAttempt}` || !DEPLOYMENT_PATTERN.test(deploymentId) ||
      !IMAGE_PATTERN.test(cubeImage) || !DIGEST_PATTERN.test(authorizationDigest) ||
      !ULID_PATTERN.test(tenantId) || !APP_PATTERN.test(appName) ||
      !MACHINE_PATTERN.test(machineId) || !PROJECT_REF_PATTERN.test(controlPlaneProjectRef)) {
    fail('configuration_invalid');
  }
  return Object.freeze({
    candidateSha,
    runId,
    runAttempt,
    deploymentId,
    cubeImage,
    authorizationDigest,
    tenantId,
    appName,
    machineId,
    controlPlaneProjectRef,
    databaseUrl,
  });
}

function validateLease(value) {
  exactKeys(value, ['leaseId', 'conversationId', 'turnId', 'expiresAt'], 'lease_invalid');
  if (!ULID_PATTERN.test(value.leaseId ?? '') ||
      !ULID_PATTERN.test(value.conversationId ?? '') ||
      !ULID_PATTERN.test(value.turnId ?? '') ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now() + 30_000 ||
      Date.parse(value.expiresAt) > Date.now() + 3 * 60_000 + 5_000) {
    fail('lease_invalid');
  }
  return Object.freeze(value);
}

async function inDiagnosticTransaction(databaseUrl, operation) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    application_name: 'albert-release-cube-smoke',
  });
  await client.connect().catch(() => fail('control_database_unavailable'));
  try {
    await client.query('BEGIN');
    const session = await client.query('SELECT session_user AS session_user');
    if (session.rows[0]?.session_user !== EXPECTED_SESSION_USER) {
      fail('control_database_identity_invalid');
    }
    await client.query(`SET LOCAL ROLE ${EXPECTED_ROLE}`);
    const role = await client.query('SELECT current_user AS current_user');
    if (role.rows[0]?.current_user !== EXPECTED_ROLE) {
      fail('control_database_role_invalid');
    }
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function issueReleaseTurn(config) {
  return inDiagnosticTransaction(config.databaseUrl, async (client) => {
    const result = await client.query(
      `SELECT control_plane.issue_protected_dogfood_semantic_turn(
         $1::text,$2::text,$3::text,$4::text,$5::integer,$6::text,$7::integer
       ) AS lease`,
      [
        config.tenantId,
        config.candidateSha,
        config.deploymentId,
        config.runId,
        config.runAttempt,
        'release_cube_smoke',
        1,
      ],
    );
    return validateLease(result.rows[0]?.lease);
  });
}

export async function finishReleaseTurn(config, lease, succeeded, resultDigest) {
  if (typeof succeeded !== 'boolean' || !DIGEST_PATTERN.test(resultDigest)) {
    fail('result_invalid');
  }
  return inDiagnosticTransaction(config.databaseUrl, async (client) => {
    const result = await client.query(
      `SELECT control_plane.finish_protected_dogfood_semantic_turn(
         $1::text,$2::boolean,$3::text
       ) AS finished`,
      [lease.leaseId, succeeded, resultDigest],
    );
    if (result.rows[0]?.finished !== true) fail('lease_finalization_failed');
    return true;
  });
}

function encodedTurn(config, lease) {
  return Buffer.from(JSON.stringify({
    tenant_id: config.tenantId,
    conversation_id: lease.conversationId,
    turn_id: lease.turnId,
  }), 'utf8').toString('base64url');
}

function markerPayload(value) {
  if (typeof value !== 'string') return null;
  const markerIndex = value.lastIndexOf(PROOF_MARKER);
  if (markerIndex === -1) return null;
  const suffix = value.slice(markerIndex + PROOF_MARKER.length);
  const line = suffix.split(/\r?\n/u, 1)[0]?.trim();
  if (!line || line.length > 16 * 1024) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function findMarkerPayload(value, depth = 0) {
  if (depth > 5) return null;
  const direct = markerPayload(value);
  if (direct) return direct;
  if (typeof value === 'string') {
    try {
      return findMarkerPayload(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findMarkerPayload(item, depth + 1);
      if (match) return match;
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const match = findMarkerPayload(item, depth + 1);
      if (match) return match;
    }
  }
  return null;
}

export function validateMachineProof(proof) {
  exactKeys(proof, ['schemaVersion', 'ok', 'meta', 'query'], 'machine_proof_invalid');
  if (proof.schemaVersion !== 1 || proof.ok !== true) fail('machine_proof_failed');
  exactKeys(proof.meta, [
    'view', 'privacyPolicy', 'minimumTimeGranularity',
    'privacyMinimumGroupSize', 'privacyPopulationMeasure',
    'measures', 'timeDimension',
  ], 'machine_meta_proof_invalid');
  exactKeys(proof.query, [
    'measures', 'timeDimension', 'granularity',
    'emptyFutureWindow', 'rowCount',
  ], 'machine_query_proof_invalid');
  const measures = [
    'shopify_sales_analytics.current_total_sales',
    'shopify_sales_analytics.orders',
    'shopify_sales_analytics.distinct_protected_subjects',
  ];
  if (proof.meta.view !== 'shopify_sales_analytics' ||
      proof.meta.privacyPolicy !== 'aggregate_only' ||
      proof.meta.minimumTimeGranularity !== 'day' ||
      proof.meta.privacyMinimumGroupSize !== 5 ||
      proof.meta.privacyPopulationMeasure !== 'distinct_protected_subjects' ||
      proof.meta.timeDimension !== 'shopify_sales_analytics.processed_at' ||
      proof.query.timeDimension !== 'shopify_sales_analytics.processed_at' ||
      proof.query.granularity !== 'day' || proof.query.emptyFutureWindow !== true ||
      proof.query.rowCount !== 0 ||
      JSON.stringify(proof.meta.measures) !== JSON.stringify(measures) ||
      JSON.stringify(proof.query.measures) !== JSON.stringify(measures)) {
    fail('machine_proof_invalid');
  }
  return proof;
}

export async function executeMachineSmoke(config, lease, runner = execFileAsync) {
  const command = `node /cube/conf/scripts/release-smoke.mjs ${encodedTurn(config, lease)}`;
  let stdout;
  try {
    ({ stdout } = await runner(
      'flyctl',
      [
        'machine', 'exec', config.machineId, command,
        '--app', config.appName,
        '--json',
        '--timeout', '120',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 135_000,
        windowsHide: true,
        env: process.env,
      },
    ));
  } catch {
    fail('machine_execution_failed');
  }
  const proof = findMarkerPayload(stdout);
  if (!proof) fail('machine_proof_missing');
  return validateMachineProof(proof);
}

export function releaseProof(config, machineProof) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'albert.production-cube-release-smoke',
    candidateSha: config.candidateSha,
    deploymentId: config.deploymentId,
    cubeImage: config.cubeImage,
    authorizationDigest: config.authorizationDigest,
    meta: machineProof.meta,
    query: machineProof.query,
  });
}

/**
 * @param {{
 *   source?: Readonly<Record<string, string | undefined>>,
 *   outputPath?: string,
 *   issue?: typeof issueReleaseTurn,
 *   execute?: typeof executeMachineSmoke,
 *   finish?: typeof finishReleaseTurn,
 * }} [options]
 */
export async function runProductionCubeReleaseSmoke({
  source = process.env,
  outputPath,
  issue = issueReleaseTurn,
  execute = executeMachineSmoke,
  finish = finishReleaseTurn,
} = {}) {
  const config = loadConfiguration(source);
  let lease;
  let finalized = false;
  try {
    lease = await issue(config);
    const proof = releaseProof(config, await execute(config, lease));
    const resultDigest = sha256(proof);
    if (outputPath) {
      const resolved = path.resolve(outputPath);
      const runnerTemp = source.RUNNER_TEMP ? path.resolve(source.RUNNER_TEMP) : null;
      if (!runnerTemp || (resolved !== runnerTemp && !resolved.startsWith(`${runnerTemp}${path.sep}`))) {
        fail('proof_output_path_invalid');
      }
      await writeFile(
        resolved,
        `${JSON.stringify({ ...proof, resultDigest })}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    }
    await finish(config, lease, true, resultDigest);
    finalized = true;
    return Object.freeze({ proof, resultDigest });
  } catch (error) {
    if (lease && !finalized) {
      const failureDigest = sha256({
        schemaVersion: 1,
        kind: 'albert.production-cube-release-smoke-failure',
        candidateSha: config.candidateSha,
        deploymentId: config.deploymentId,
        cubeImage: config.cubeImage,
        authorizationDigest: config.authorizationDigest,
        failureCode: safeFailureCode(error),
      });
      await finish(config, lease, false, failureDigest).catch(() => undefined);
    }
    throw new SafeReleaseSmokeError(safeFailureCode(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { resultDigest } = await runProductionCubeReleaseSmoke({
      outputPath: process.argv[2],
    });
    process.stdout.write(`Authenticated Cube meta and empty Shopify semantic query passed (${resultDigest}).\n`);
  } catch (error) {
    const code = safeFailureCode(error);
    process.stderr.write(`Authenticated Cube release proof failed (${code}).\n`);
    process.exitCode = 1;
  }
}
