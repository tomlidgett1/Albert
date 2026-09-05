import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isConnectorPackVersion } from "../../packages/connector-sdk/src/contract.js";
import { loadConnectorPackActivationInput } from "../../scripts/activate-connector-pack.js";
import {
  deriveConnectionRetirementEvidence,
  loadConnectorPackConnectionRetirementInput,
  type ControlPlaneRetirementSnapshot,
} from "../../scripts/retire-connector-pack-connection.js";

const tenantId="01K80000000000000000000100";
const connectionId="01K80000000000000000000101";
const requestId="01K80000000000000000000102";
const auditId="01K80000000000000000000103";
const disconnectedAt="2026-08-04T02:03:04.000Z";

const disconnectedSnapshot:ControlPlaneRetirementSnapshot=Object.freeze({
  tenantId,tenantStatus:"active",connectionId,connectorKey:"lightspeed-r",
  connectionStatus:"disconnected",authHealth:"revoked",connectionGeneration:"7",
  disconnectedAt,deletionRequestId:requestId,deletionScope:"connection",
  deletionConnectionId:connectionId,deletionStatus:"running",
  deletionRequestedAt:disconnectedAt,deletionApprovedAt:null,
  auditTenantId:tenantId,auditId,auditAction:"connection.disconnect_requested",
  auditResourceType:"connection",auditResourceId:connectionId,
  auditMetadata:Object.freeze({
    durable_before_credential_destruction:true,
    connection_generation:7,
    deletion_request_id:requestId,
  }),
  auditOccurredAt:disconnectedAt,
});

const expected=Object.freeze({tenantId,connectionId,connectorId:"lightspeed-r" as const});

test("connector pack versions require complete bounded SemVer syntax",()=>{
  assert.equal(isConnectorPackVersion("1.2.3"),true);
  assert.equal(isConnectorPackVersion("1.2.3-rc.1+build.5"),true);
  assert.equal(isConnectorPackVersion("0.0.0-alpha"),true);
  for(const invalid of ["1.2","v1.2.3","01.2.3","1.02.3","1.2.03","1.2.3-01","1.2.3+"]){
    assert.equal(isConnectorPackVersion(invalid),false,invalid);
  }
  assert.equal(isConnectorPackVersion(`1.2.3+${"a".repeat(121)}`),false);
});

test("retirement evidence is derived from exact locked control-plane state",()=>{
  const first=deriveConnectionRetirementEvidence(disconnectedSnapshot,expected);
  const reordered=deriveConnectionRetirementEvidence({
    ...disconnectedSnapshot,
    auditMetadata:{
      deletion_request_id:requestId,
      connection_generation:7,
      durable_before_credential_destruction:true,
    },
  },expected);
  assert.equal(first.retirementReason,"disconnected");
  assert.equal(first.controlPlaneAuditId,auditId);
  assert.match(first.controlPlaneEvidenceSha256,/^[a-f0-9]{64}$/u);
  assert.equal(reordered.controlPlaneEvidenceSha256,first.controlPlaneEvidenceSha256);
});

test("forged or non-durable retirement evidence fails closed",()=>{
  const attempts:readonly ControlPlaneRetirementSnapshot[]=[
    {...disconnectedSnapshot,auditTenantId:"01K80000000000000000000999"},
    {...disconnectedSnapshot,auditAction:"connection.health_changed"},
    {...disconnectedSnapshot,auditResourceId:"01K80000000000000000000999"},
    {...disconnectedSnapshot,auditMetadata:{
      deletion_request_id:"01K80000000000000000000999",connection_generation:7,
    }},
    {...disconnectedSnapshot,auditMetadata:{
      deletion_request_id:requestId,connection_generation:8,
    }},
    {...disconnectedSnapshot,deletionStatus:"cancelled"},
    {...disconnectedSnapshot,connectionStatus:"blocked"},
  ];
  for(const forged of attempts){
    assert.throws(()=>deriveConnectionRetirementEvidence(forged,expected));
  }
});

test("approved tenant deletion is a distinct durable retirement proof",()=>{
  const evidence=deriveConnectionRetirementEvidence({
    ...disconnectedSnapshot,tenantStatus:"deleting",connectionStatus:"blocked",
    disconnectedAt:null,deletionScope:"tenant",deletionConnectionId:null,
    deletionApprovedAt:"2026-08-04T02:05:00.000Z",
    auditAction:"tenant.deletion_requested",auditResourceType:"deletion_request",
    auditResourceId:requestId,auditMetadata:{approval_expires_at:"2026-08-04T02:30:00Z"},
  },expected);
  assert.equal(evidence.retirementReason,"tenant_deleting");
});

test("retirement CLI accepts identities only and derives audit inputs itself",()=>{
  const environment={
    NODE_ENV:"test",
    CONTROL_PLANE_MIGRATION_URL:
      "postgresql://albert_control_deployer:secret@localhost/control",
    ANALYTICAL_MIGRATION_URL:
      "postgresql://albert_analytical_deployer:secret@localhost/analytical",
  } as const;
  const arguments_=[
    `--tenant=${tenantId}`,`--connection=${connectionId}`,
    "--connector=lightspeed-r","--candidate=1.1.0","--expected-active=1.0.0",
  ];
  const input=loadConnectorPackConnectionRetirementInput(environment,arguments_);
  assert.equal(input.controlPlaneDatabaseUrl,environment.CONTROL_PLANE_MIGRATION_URL);
  assert.equal(input.analyticalDatabaseUrl,environment.ANALYTICAL_MIGRATION_URL);
  assert.throws(
    ()=>loadConnectorPackConnectionRetirementInput(environment,[
      ...arguments_,`--control-plane-audit-id=${auditId}`,
    ]),
    /Unknown connection-retirement option/u,
  );
  assert.throws(
    ()=>loadConnectorPackConnectionRetirementInput({
      ...environment,
      CONTROL_PLANE_MIGRATION_URL:"postgresql://postgres:secret@localhost/control",
    },arguments_),
    /albert_control_deployer/u,
  );
});

test("activation CLI requires explicit predecessor and exact analytical deployer",()=>{
  const environment={
    NODE_ENV:"test",
    ANALYTICAL_MIGRATION_URL:
      "postgresql://albert_analytical_deployer:secret@localhost/analytical",
  } as const;
  const input=loadConnectorPackActivationInput(environment,[
    "--connector=lightspeed-r","--candidate=1.2.0-rc.1+build.5",
    "--expected-active=1.1.0","--check",
  ]);
  assert.equal(input.checkOnly,true);
  assert.equal(input.candidatePackVersion,"1.2.0-rc.1+build.5");
  assert.throws(()=>loadConnectorPackActivationInput(environment,[
    "--connector=lightspeed-r","--candidate=01.2.0","--expected-active=1.1.0",
  ]),/release-grade semantic versions/u);
  assert.throws(()=>loadConnectorPackActivationInput({
    ...environment,
    ANALYTICAL_MIGRATION_URL:"postgresql://postgres:secret@localhost/analytical",
  },[
    "--connector=lightspeed-r","--candidate=1.2.0","--expected-active=1.1.0",
  ]),/albert_analytical_deployer/u);
});

test("historical pack activation uses staged evidence, atomic views, stale-write fences, and deletion",()=>{
  const migration=readFileSync(new URL(
    "../../infra/migrations/analytical/0095_m5_atomic_connector_pack_activation.sql",
    import.meta.url,
  ),"utf8");
  const activationVariableHardening=readFileSync(new URL(
    "../../infra/migrations/analytical/0099_m5_connector_pack_activation_variable_disambiguation.sql",
    import.meta.url,
  ),"utf8");
  assert.doesNotMatch(migration,/ALTER TABLE semantic_internal\.tenant_capability\s+DROP CONSTRAINT/u);
  assert.doesNotMatch(migration,/ALTER TABLE semantic_internal\.source_field_allowlist\s+DROP CONSTRAINT/u);
  assert.match(migration,/CREATE TABLE semantic_internal\.connector_pack_tenant_capability_snapshot/u);
  assert.match(migration,/CREATE TABLE semantic_internal\.connector_pack_source_field_snapshot/u);
  assert.match(migration,/PRIMARY KEY \(tenant_id,capability,source_key,pack_version\)/u);
  assert.match(migration,/PRIMARY KEY \(tenant_id,connection_id,source_table,source_field,pack_version\)/u);
  assert.match(migration,/CREATE TRIGGER connector_pack_tenant_capability_route/u);
  assert.match(migration,/CREATE TRIGGER connector_pack_source_field_route/u);
  assert.match(migration,/connector_pack_capability_evidence_index[\s\S]*connector_pack_tenant_capability_snapshot/u);
  assert.match(migration,/connector_pack_source_field_evidence_index[\s\S]*connector_pack_source_field_snapshot/u);
  assert.match(migration,/TG_TABLE_NAME IN \([\s\S]*connector_pack_tenant_capability_snapshot/u);
  assert.match(migration,/CREATE VIEW semantic_internal\.active_tenant_capability/u);
  assert.match(migration,/CREATE VIEW semantic_internal\.active_source_field_allowlist/u);
  assert.match(migration,/active_tenant_capability[\s\S]*UNION ALL[\s\S]*connector_pack_tenant_capability_snapshot/u);
  assert.match(migration,/active_source_field_allowlist[\s\S]*UNION ALL[\s\S]*connector_pack_source_field_snapshot/u);
  assert.match(migration,/BEFORE INSERT OR UPDATE\s+ON semantic_internal\.tenant_capability/u);
  assert.match(migration,/BEFORE INSERT OR UPDATE\s+ON semantic_internal\.source_field_allowlist/u);
  assert.match(migration,/FOR UPDATE;\s+IF NOT EXISTS \(/u);
  assert.match(migration,/connector_pack_connection_retirement_mutation/u);
  assert.match(migration,/deletion_internal\.mutation_authorized\(\)/u);
  assert.match(migration,/purge_connection_before_connector_pack_retirement/u);
  assert.match(
    activationVariableHardening,
    /CREATE OR REPLACE FUNCTION semantic_internal\.activate_connector_pack/u,
  );
  assert.match(
    activationVariableHardening,
    /retired_at=activation_time[\s\S]*activated_at=activation_time/u,
  );
  assert.doesNotMatch(
    activationVariableHardening,
    /retired_at=activated_at/u,
  );
  assert.match(
    activationVariableHardening,
    /GRANT EXECUTE ON FUNCTION semantic_internal\.activate_connector_pack\(text,text,text\)[\s\S]*TO albert_migration_owner/u,
  );

});
