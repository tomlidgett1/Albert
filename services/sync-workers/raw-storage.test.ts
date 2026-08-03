import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  RawBatchContext,
  RawBatchManifest,
  RawBatchRecord,
  RawStorageS3Config,
} from "../../packages/storage/src/index.js";
import type { MachineSessionIdentity } from "../../packages/storage/src/session-credentials.js";
import {
  LeaseBoundSyncRawWriter,
  type RawStorageSyncSessionControl,
  type SyncScopedObjectStoreFactory,
} from "./src/raw-storage.js";

const config: RawStorageS3Config = {
  endpoint: "https://example.storage.supabase.co/storage/v1/s3",
  authUrl: "https://example.supabase.co",
  region: "ap-southeast-2",
  accessKeyId: "example",
  legacyAnonKey: "header.payload.signature",
  machinePurpose: "sync",
  machineEmail: "raw-storage-sync@machine.albert.invalid",
  machinePassword: "sync-machine-password-material-00000001",
  bucket: "raw-payloads",
};
const identity: MachineSessionIdentity = Object.freeze({
  userId: "10000000-0000-4000-8000-000000000001",
  sessionId: "20000000-0000-4000-8000-000000000001",
  tokenExpiresAt: new Date(Date.now()+10*60_000),
});
const baseContext: RawBatchContext = Object.freeze({
  tenantId: "01J90000000000000000000001",
  connectionId: "01J90000000000000000000002",
  syncRunId: "01J90000000000000000000003",
  batchId: "01J90000000000000000000004",
  connectorKey: "deputy",
  connectorVersion: "1.0.0",
  apiVersion: "v1",
  externalAccountReference: "account-a",
  stream: "employees",
  extractedAt: "2026-08-03T00:00:00.000Z",
  cursorStart: null,
  cursorEnd: null,
});
const payload = Object.freeze({ id: "employee-1" });
const records: readonly RawBatchRecord[] = Object.freeze([{
  sourceObjectType: "Employee",
  sourceRecordId: "employee-1",
  payload,
  payloadHash: createHash("sha256").update('{"id":"employee-1"}').digest("hex"),
}]);

class Manifests {
  readonly values = new Map<string, RawBatchManifest>();
  readonly events: string[];
  constructor(events: string[]) { this.events=events; }
  async find(_tenantId: string,batchId: string) { return this.values.get(batchId) ?? null; }
  async registerUploaded(manifest: RawBatchManifest) {
    this.events.push(`manifest:${manifest.batchId}`);
    this.values.set(manifest.batchId,manifest);
  }
}

function objectFactory(
  events: string[],
  options: Readonly<{ fail?: boolean }> = {},
): SyncScopedObjectStoreFactory {
  return (scope,authorize) => ({
    async putIfAbsent(input) {
      await authorize(identity);
      events.push(`s3:${scope.objectKey}`);
      assert.equal(input.key,scope.objectKey);
      if(options.fail) throw new Error("synthetic_s3_failure");
      return "created";
    },
    async read() { return null; },
    destroy() { events.push(`destroy:${scope.objectKey}`); },
  });
}

test("sync raw writer issues before S3 and revokes/destroys after success",async()=>{
  const events:string[]=[];
  const control:RawStorageSyncSessionControl={
    async issueRawStorageSyncSession(input){
      events.push(`issue:${input.objectKey}`);
      assert.equal(input.identity,identity);
      return {
        grantId:"01J9000000000000000000000A",tenantId:baseContext.tenantId,
        connectionId:baseContext.connectionId,objectKey:input.objectKey,
        expiresAt:new Date(Date.now()+2*60_000).toISOString(),
      };
    },
    async revokeRawStorageSyncSession(input){events.push(`revoke:${input.grantId}`);},
  };
  const writer=new LeaseBoundSyncRawWriter(
    config,new Manifests(events),control,undefined,objectFactory(events),
  );

  await writer.write(baseContext,records,{permitId:"01J9000000000000000000000B",workerId:"worker-a"});

  assert.ok(events[0]?.startsWith("issue:"));
  assert.ok(events[1]?.startsWith("s3:"));
  assert.ok(events.some((event)=>event.startsWith("manifest:")));
  assert.deepEqual(events.slice(-2),[
    `destroy:${baseContext.tenantId}`.replace(baseContext.tenantId,
      `tenant/${baseContext.tenantId}/connection/${baseContext.connectionId}/stream/employees/date/2026-08-03/batch-${baseContext.batchId}.jsonl.gz`),
    "revoke:01J9000000000000000000000A",
  ]);
});

test("sync raw writer revokes and destroys when S3 or returned scope validation fails",async()=>{
  for(const failure of ["s3","scope"] as const){
    const events:string[]=[];
    const control:RawStorageSyncSessionControl={
      async issueRawStorageSyncSession(input){
        events.push("issue");
        return {
          grantId:"01J9000000000000000000000C",tenantId:baseContext.tenantId,
          connectionId:failure==="scope"?"01J9000000000000000000000D":baseContext.connectionId,
          objectKey:input.objectKey,expiresAt:new Date(Date.now()+2*60_000).toISOString(),
        };
      },
      async revokeRawStorageSyncSession(input){events.push(`revoke:${input.grantId}`);},
    };
    const writer=new LeaseBoundSyncRawWriter(
      config,new Manifests(events),control,undefined,
      objectFactory(events,{fail:failure==="s3"}),
    );
    await assert.rejects(
      writer.write(baseContext,records,{permitId:"01J9000000000000000000000E",workerId:"worker-a"}),
      failure==="s3"?/synthetic_s3_failure/:/grant_scope_mismatch/,
    );
    assert.ok(events.some((event)=>event.startsWith("destroy:")));
    assert.ok(events.includes("revoke:01J9000000000000000000000C"));
  }
});

test("parallel sync object grants are independently issued and revoked",async()=>{
  const events:string[]=[];
  const manifests=new Manifests(events);
  const grants=new Map<string,string>();
  const control:RawStorageSyncSessionControl={
    async issueRawStorageSyncSession(input){
      const grantId=input.objectKey.includes("employees")
        ?"01J9000000000000000000000F":"01J9000000000000000000000G";
      grants.set(input.objectKey,grantId);
      return {grantId,tenantId:baseContext.tenantId,connectionId:baseContext.connectionId,
        objectKey:input.objectKey,expiresAt:new Date(Date.now()+2*60_000).toISOString()};
    },
    async revokeRawStorageSyncSession(input){events.push(`revoke:${input.grantId}`);},
  };
  const writer=new LeaseBoundSyncRawWriter(config,manifests,control,undefined,objectFactory(events));
  const second={...baseContext,syncRunId:"01J9000000000000000000000H",
    batchId:"01J9000000000000000000000J",stream:"timesheets"};

  await Promise.all([
    writer.write(baseContext,records,{permitId:"01J9000000000000000000000K",workerId:"worker-a"}),
    writer.write(second,records,{permitId:"01J9000000000000000000000M",workerId:"worker-a"}),
  ]);

  assert.equal(grants.size,2);
  assert.deepEqual(events.filter((event)=>event.startsWith("revoke:")).sort(),[
    "revoke:01J9000000000000000000000F",
    "revoke:01J9000000000000000000000G",
  ]);
});

test("sync raw writer attempts every refreshed grant revocation when one fails",async()=>{
  const grantIds=[
    "01J9000000000000000000000N",
    "01J9000000000000000000000P",
  ] as const;
  const revoked:string[]=[];
  let issued=0;
  const control:RawStorageSyncSessionControl={
    async issueRawStorageSyncSession(input){
      const grantId=grantIds[issued++];
      assert.ok(grantId);
      return {grantId,tenantId:baseContext.tenantId,connectionId:baseContext.connectionId,
        objectKey:input.objectKey,expiresAt:new Date(Date.now()+2*60_000).toISOString()};
    },
    async revokeRawStorageSyncSession(input){
      revoked.push(input.grantId);
      if(input.grantId===grantIds[0])throw new Error("synthetic_first_revoke_failure");
    },
  };
  const factory:SyncScopedObjectStoreFactory=(_scope,authorize)=>({
    async putIfAbsent(){
      await authorize(identity);
      await authorize(identity);
      return "created";
    },
    async read(){return null;},
    destroy(){},
  });
  const writer=new LeaseBoundSyncRawWriter(
    config,new Manifests([]),control,undefined,factory,
  );

  await assert.rejects(
    writer.write(baseContext,records,{permitId:"01J9000000000000000000000Q",workerId:"worker-a"}),
    /sync_raw_storage_session_cleanup_failed/,
  );
  assert.deepEqual(revoked.sort(),[...grantIds].sort());
});
