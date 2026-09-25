import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { MomenceConnector } from "../../connectors/momence/index";
import {
  MOMENCE_ENTITY_VALIDATION_CONTRACTS,
  MOMENCE_OPENAPI_COVERAGE,
} from "../../connectors/momence/openapi-coverage.generated";
import type { MomenceEntitySchema } from "../../connectors/momence/openapi-coverage-types";
import {
  momenceEntityValidationContract,
  validateMomenceEntity,
} from "../../connectors/momence/openapi-validator";
import { MOMENCE_READ_STREAMS, type MomenceStreamId } from "../../connectors/momence/streams";
import {
  hashPayload,
  type ConnectorContext,
  type FetchLike,
  type OAuthCredentialSecret,
  type VersionedCredential,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index";
import type { CredentialRefreshLeaseContext } from "../../packages/connector-sdk/src/oauth";

const context: ConnectorContext = {
  tenantId: "tenant-momence-validator",
  connectionId: "connection-momence-validator",
  credentialRef: "credential:momence-validator",
};

class MemoryVault implements WorkerCredentialVault {
  private readonly secret: OAuthCredentialSecret = {
    provider: "momence",
    accessToken: "access-momence-validator",
    refreshToken: "refresh-momence-validator",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["public-api-v2"],
    metadata: {},
  };

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    return { credentialRef: context.credentialRef, revision: "1", secret };
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    return { credentialRef, revision: "1", secret: this.secret };
  }

  async compareAndSwap(
    credentialRef: string,
    _expectedRevision: string,
    secret: OAuthCredentialSecret,
  ): Promise<VersionedCredential> {
    return { credentialRef, revision: "2", secret };
  }

  async withRefreshLease<T>(
    _credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
  ): Promise<T> {
    return operation({
      abortSignal: new AbortController().signal,
      proof: { leaseId: "lease-momence-validator", fencingToken: "1" },
    });
  }

  async destroy(): Promise<void> {}
}

function fixture(schema: MomenceEntitySchema, path = "$root"): unknown {
  if (schema.kind === "object") {
    return Object.fromEntries(schema.required.map((name) => {
      const property = schema.properties[name];
      assert.ok(property, `${path}.${name} must have a generated schema`);
      return [name, fixture(property, `${path}.${name}`)];
    }));
  }
  if (schema.kind === "array") return [];
  if (schema.kind === "union") return fixture(schema.variants[0]!, path);
  if (schema.nullable) return null;
  if (schema.enumValues?.length) return schema.enumValues[0];
  if (schema.kind === "integer") return 7;
  if (schema.kind === "number") return 12.5;
  if (schema.kind === "boolean") return false;
  if (schema.kind === "string") {
    return schema.format === "date-time" ? "2030-01-02T03:04:05.000Z" : "official-value";
  }
  return "documented-value";
}

function objectFixture(streamId: MomenceStreamId): Record<string, unknown> {
  const contract = momenceEntityValidationContract(streamId);
  assert.equal(contract.schema.kind, "object");
  return fixture(contract.schema) as Record<string, unknown>;
}

function nestedObject(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const nested = value[name];
  assert.ok(nested && typeof nested === "object" && !Array.isArray(nested));
  return nested as Record<string, unknown>;
}

function digestContracts(): string {
  const rows = MOMENCE_ENTITY_VALIDATION_CONTRACTS
    .map((contract) => JSON.stringify(contract))
    .sort()
    .join("\n");
  return createHash("sha256").update(rows).digest("hex");
}

function hostMember(id: number): Record<string, unknown> {
  return {
    id,
    firstName: "Ava",
    lastName: "Student",
    email: "ava@example.test",
    phoneNumber: null,
    pictureUrl: null,
    firstSeen: "2029-06-01T01:02:03.000Z",
    lastSeen: "2030-01-02T03:04:05.000Z",
    visits: {
      appointments: 2,
      appointmentsVisits: 2,
      bookings: 8,
      bookingsVisits: 7,
      openAreaVisits: 1,
      total: 11,
      totalVisits: 10,
    },
    customerFields: [],
    customerTags: [],
  };
}

test("generated strict response contracts cover every Momence read stream deterministically", () => {
  assert.equal(MOMENCE_ENTITY_VALIDATION_CONTRACTS.length, MOMENCE_READ_STREAMS.length);
  assert.equal(
    MOMENCE_OPENAPI_COVERAGE.counts.entityValidationContracts,
    MOMENCE_READ_STREAMS.length,
  );
  assert.equal(
    digestContracts(),
    MOMENCE_OPENAPI_COVERAGE.digests.entityValidationContractSha256,
  );
  assert.deepEqual(
    MOMENCE_ENTITY_VALIDATION_CONTRACTS.map(({ streamId }) => streamId),
    MOMENCE_READ_STREAMS.map(({ id }) => id).sort(),
  );
  for (const contract of MOMENCE_ENTITY_VALIDATION_CONTRACTS) {
    const stream = MOMENCE_READ_STREAMS.find(({ id }) => id === contract.streamId);
    assert.ok(stream);
    assert.equal(contract.operationKey, `GET ${stream.endpoint}`);
    assert.equal(contract.responseStatus, "200");
    assert.equal(contract.contentType, "application/json");
    assert.ok(contract.rootSchema.length > 0);
    assert.ok(contract.entitySourcePointer.startsWith("#/paths/"));
    assert.equal(contract.schema.kind, "object");
  }
});

test("every generated official entity shape is admitted, including required nullable fields", () => {
  for (const { id } of MOMENCE_READ_STREAMS) {
    const value = objectFixture(id);
    assert.deepEqual(validateMomenceEntity(id, value), [], `${id} rejected its generated official shape`);
  }
  const member = objectFixture("momence_members");
  assert.equal(member.phoneNumber, null);
  assert.equal(member.pictureUrl, null);
});

test("required, type and nested unknown-field drift receive exact fail-visible paths", () => {
  const member = hostMember(41);
  delete nestedObject(member, "visits").total;
  member.id = "41";
  member["pose/name"] = "crow";
  nestedObject(member, "visits").experimentalCount = 3;

  assert.deepEqual(
    validateMomenceEntity("momence_members", member).map(({ code, path }) => ({ code, path })),
    [
      { code: "schema_invalid", path: "$.id" },
      { code: "schema_drift", path: "$.visits.experimentalCount" },
      { code: "schema_invalid", path: "$.visits.total" },
      { code: "schema_drift", path: '$["pose/name"]' },
    ],
  );
});

test("enum drift and array item types are validated from their exact component definitions", () => {
  const payment = objectFixture("momence_payment_transactions");
  payment.paymentStatus = "future-provider-status";
  const paymentIssues = validateMomenceEntity("momence_payment_transactions", payment);
  assert.equal(paymentIssues.length, 1);
  assert.deepEqual(paymentIssues[0] && {
    code: paymentIssues[0].code,
    path: paymentIssues[0].path,
  }, { code: "schema_invalid", path: "$.paymentStatus" });
  assert.match(paymentIssues[0]?.message ?? "", /outside the Momence enum/u);

  const member = hostMember(42);
  const tagsSchema = momenceEntityValidationContract("momence_members").schema;
  assert.equal(tagsSchema.kind, "object");
  const customerTags = tagsSchema.properties.customerTags;
  assert.equal(customerTags?.kind, "array");
  const tag = fixture(customerTags.items) as Record<string, unknown>;
  tag.id = "tag-id";
  member.customerTags = [tag];
  assert.deepEqual(
    validateMomenceEntity("momence_members", member).map(({ code, path }) => ({ code, path })),
    [{ code: "schema_invalid", path: "$.customerTags[0].id" }],
  );
});

test("connector preserves exact raw drift evidence and withholds the typed projection from staging", async () => {
  const validMember = hostMember(51);
  const driftedMember = structuredClone(hostMember(52));
  nestedObject(driftedMember, "visits").newVisitCategory = 9;
  const fetcher: FetchLike = async () => new Response(JSON.stringify({
    pagination: { page: 0, pageSize: 100, totalCount: 2, sortBy: null, sortOrder: null },
    payload: [driftedMember, validMember],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const pack = new MomenceConnector({
    clientId: "client-momence-validator",
    clientSecret: "secret-momence-validator",
    redirectUri: "https://app.example.test/api/oauth/momence/callback",
    vault: new MemoryVault(),
    fetcher,
    retry: { maxAttempts: 1 },
    now: () => Date.parse("2030-01-03T00:00:00.000Z"),
  });
  const members = (await pack.list_streams(context)).find(({ id }) => id === "momence_members");
  assert.ok(members);

  const result = await pack.initial_sync(context, members, {
    from: "2029-01-01T00:00:00.000Z",
    to: "2031-01-01T00:00:00.000Z",
  });
  const drifted = result.records[0];
  assert.deepEqual(drifted?.payload, driftedMember, "quarantine must retain exact provider JSON");
  assert.equal(drifted?.payloadHash, hashPayload(driftedMember));
  assert.equal(drifted?.normalized, undefined, "drift must never enter typed staging");
  assert.deepEqual(
    drifted?.validationIssues?.map(({ code, path }) => ({ code, path })),
    [{ code: "schema_drift", path: "$.visits.newVisitCategory" }],
  );

  const admitted = result.records[1];
  assert.deepEqual(admitted?.payload, validMember);
  assert.equal(admitted?.validationIssues, undefined);
  assert.ok(admitted?.normalized, "an exact official response shape remains queryable");
  assert.ok(
    (admitted.normalized.fields.fieldIndex as readonly Readonly<Record<string, unknown>>[])
      .some(({ path, numericValue }) => path === "$.visits.total" && numericValue === "11"),
  );
});
