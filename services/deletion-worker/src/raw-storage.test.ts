import assert from "node:assert/strict";
import test from "node:test";
import type { RawStorageS3Config } from "../../../packages/storage/src/s3.js";
import type { MachineSessionIdentity } from "../../../packages/storage/src/session-credentials.js";
import type { DeletionClaim } from "./store.js";
import {
  LeaseBoundRawStoragePurger,
  RawStoragePurger,
  type DeletionScopedObjectStoreFactory,
  type RawDeletionObjectStore,
  type RawStorageDeletionSessionControl,
} from "./raw-storage.js";

class MemoryObjects implements RawDeletionObjectStore {
  readonly files = new Set<string>();

  async listPrefix(prefix: string) {
    return {
      keys: [...this.files].filter((key) => key.startsWith(prefix)).sort().slice(0, 1_000),
    };
  }

  async deleteKeys(keys: readonly string[]) {
    keys.forEach((key) => this.files.delete(key));
  }
}

test("raw purge deletes only the exact connection prefix and verifies the result", async () => {
  const tenant = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const target = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const retained = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const objects = new MemoryObjects();
  objects.files.add(`tenant/${tenant}/connection/${target}/run/batch/records.ndjson.gz`);
  objects.files.add(`tenant/${tenant}/connection/${target}/run/batch/manifest.json.gz`);
  objects.files.add(`tenant/${tenant}/connection/${retained}/run/batch/records.ndjson.gz`);
  const purger = new RawStoragePurger(objects);

  const result = await purger.purge(tenant, target);

  assert.equal(result.verified, true);
  assert.equal(result.objectsRemoved, 2);
  assert.deepEqual([...objects.files], [
    `tenant/${tenant}/connection/${retained}/run/batch/records.ndjson.gz`,
  ]);
});

test("tenant purge removes more than one S3 page without stale cursors", async () => {
  const tenant = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const objects = new MemoryObjects();
  for (let index = 0; index < 1_205; index += 1) {
    objects.files.add(
      `tenant/${tenant}/connection/01ARZ3NDEKTSV4RRFFQ69G5FAW/run/batch/${String(index).padStart(4, "0")}.gz`,
    );
  }
  const purger = new RawStoragePurger(objects);

  assert.equal((await purger.purge(tenant, null)).objectsRemoved, 1_205);
  assert.equal((await purger.verify(tenant, null)).remainingObjects, 0);
});

test("raw purge rejects a broad or malformed deletion scope", async () => {
  await assert.rejects(
    new RawStoragePurger(new MemoryObjects()).purge("tenant", null),
    /raw_deletion_scope_invalid/,
  );
});

const s3Config:RawStorageS3Config={
  endpoint:"https://example.storage.supabase.co/storage/v1/s3",
  authUrl:"https://example.supabase.co",region:"ap-southeast-2",accessKeyId:"example",
  legacyAnonKey:"header.payload.signature",machinePurpose:"deletion",
  machineEmail:"raw-storage-deletion@machine.albert.invalid",
  machinePassword:"deletion-machine-password-material-00001",bucket:"raw-payloads",
};
const claim:DeletionClaim=Object.freeze({
  messageId:71,readCount:1,visibilityDeadline:new Date(Date.now()+10*60_000).toISOString(),
  requestId:"01J90000000000000000000001",tenantId:"01J90000000000000000000002",
  connectionId:"01J90000000000000000000003",scope:"connection",
});
const machineIdentity:MachineSessionIdentity=Object.freeze({
  userId:"10000000-0000-4000-8000-000000000001",
  sessionId:"20000000-0000-4000-8000-000000000001",
  tokenExpiresAt:new Date(Date.now()+10*60_000),
});

function scopedFactory(
  events:string[],files:Set<string>,failDelete=false,
):DeletionScopedObjectStoreFactory{
  return (scope,authorize)=>{
    let authorization:Promise<Readonly<{expiresAt:Date}>>|undefined;
    const ensure=()=>authorization??=authorize(machineIdentity);
    const prefix=scope.connectionId
      ?`tenant/${scope.tenantId}/connection/${scope.connectionId}/`
      :`tenant/${scope.tenantId}/`;
    return {
      async listPrefix(value){
        await ensure();events.push(`list:${value}`);assert.equal(value,prefix);
        return {keys:[...files].filter((key)=>key.startsWith(value)).slice(0,1_000)};
      },
      async deleteKeys(keys){
        await ensure();events.push(`delete:${keys.length}`);
        if(failDelete)throw new Error("synthetic_delete_failure");
        keys.forEach((key)=>files.delete(key));
      },
      destroy(){events.push(`destroy:${scope.operation}`);},
    };
  };
}

function sessionControl(
  events:string[],overrides:Partial<{
    tenantId:string;operation:"purge"|"verify";expiresAt:string;
  }>={},
):RawStorageDeletionSessionControl{
  return {
    async issueRawStorageSession(_claim,operation,identity){
      events.push(`issue:${operation}`);assert.equal(identity,machineIdentity);
      return {grantId:"01J90000000000000000000004",
        tenantId:overrides.tenantId??claim.tenantId,scope:claim.scope,
        connectionId:claim.connectionId,operation:overrides.operation??operation,
        expiresAt:overrides.expiresAt??new Date(Date.now()+2*60_000).toISOString()};
    },
    async revokeRawStorageSession(_claim,grantId){events.push(`revoke:${grantId}`);},
  };
}

test("lease-bound deletion issues before S3 and revokes/destroys after success",async()=>{
  const events:string[]=[];
  const key=`tenant/${claim.tenantId}/connection/${claim.connectionId}/stream/sales/date/2026-08-03/batch-01J90000000000000000000005.jsonl.gz`;
  const files=new Set([key]);
  const raw=new LeaseBoundRawStoragePurger(
    s3Config,sessionControl(events),undefined,scopedFactory(events,files),
  );

  const result=await raw.purge(claim);

  assert.equal(result.objectsRemoved,1);
  assert.equal(events[0],"issue:purge");
  assert.ok(events[1]?.startsWith("list:"));
  assert.deepEqual(events.slice(-2),[
    "destroy:purge","revoke:01J90000000000000000000004",
  ]);
});

test("lease-bound deletion revokes/destroys on S3, scope, or expiry failure",async()=>{
  const cases=[
    {name:"s3",fail:true,overrides:{}},
    {name:"scope",fail:false,overrides:{tenantId:"01J90000000000000000000006"}},
    {name:"expiry",fail:false,overrides:{expiresAt:new Date(Date.now()+20*60_000).toISOString()}},
  ] as const;
  for(const candidate of cases){
    const events:string[]=[];
    const files=new Set([
      `tenant/${claim.tenantId}/connection/${claim.connectionId}/stream/sales/date/2026-08-03/batch-01J90000000000000000000007.jsonl.gz`,
    ]);
    const raw=new LeaseBoundRawStoragePurger(
      s3Config,sessionControl(events,candidate.overrides),undefined,
      scopedFactory(events,files,candidate.fail),
    );
    await assert.rejects(raw.purge(claim));
    assert.ok(events.includes("destroy:purge"),candidate.name);
    assert.ok(events.includes("revoke:01J90000000000000000000004"),candidate.name);
  }
});

test("parallel deletion scopes revoke only their own grants",async()=>{
  const events:string[]=[];
  const second:DeletionClaim={...claim,messageId:72,
    requestId:"01J90000000000000000000008",connectionId:"01J90000000000000000000009"};
  const grants=new Map<string,string>();
  const control:RawStorageDeletionSessionControl={
    async issueRawStorageSession(value,operation){
      const grantId=value.requestId===claim.requestId
        ?"01J9000000000000000000000A":"01J9000000000000000000000B";
      grants.set(value.requestId,grantId);
      return {grantId,tenantId:value.tenantId,scope:value.scope,connectionId:value.connectionId,
        operation,expiresAt:new Date(Date.now()+2*60_000).toISOString()};
    },
    async revokeRawStorageSession(value,grantId){events.push(`revoke:${value.requestId}:${grantId}`);},
  };
  const raw=new LeaseBoundRawStoragePurger(
    s3Config,control,undefined,(scope,authorize)=>scopedFactory(
      events,new Set<string>(),
    )(scope,authorize),
  );

  await Promise.all([raw.verify(claim),raw.verify(second)]);

  assert.equal(grants.size,2);
  assert.deepEqual(events.filter((event)=>event.startsWith("revoke:")).sort(),[
    `revoke:${claim.requestId}:01J9000000000000000000000A`,
    `revoke:${second.requestId}:01J9000000000000000000000B`,
  ]);
});

test("lease-bound deletion attempts every refreshed grant revocation when one fails",async()=>{
  const grantIds=[
    "01J9000000000000000000000C",
    "01J9000000000000000000000D",
  ] as const;
  const revoked:string[]=[];
  let issued=0;
  const control:RawStorageDeletionSessionControl={
    async issueRawStorageSession(value,operation){
      const grantId=grantIds[issued++];
      assert.ok(grantId);
      return {grantId,tenantId:value.tenantId,scope:value.scope,connectionId:value.connectionId,
        operation,expiresAt:new Date(Date.now()+2*60_000).toISOString()};
    },
    async revokeRawStorageSession(_value,grantId){
      revoked.push(grantId);
      if(grantId===grantIds[0])throw new Error("synthetic_first_revoke_failure");
    },
  };
  const factory:DeletionScopedObjectStoreFactory=(_scope,authorize)=>({
    async listPrefix(){
      await authorize(machineIdentity);
      await authorize(machineIdentity);
      return {keys:[]};
    },
    async deleteKeys(){},
    destroy(){},
  });
  const raw=new LeaseBoundRawStoragePurger(s3Config,control,undefined,factory);

  await assert.rejects(raw.verify(claim),/raw_deletion_session_cleanup_failed/);
  assert.deepEqual(revoked.sort(),[...grantIds].sort());
});
