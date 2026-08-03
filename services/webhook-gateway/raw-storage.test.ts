import assert from "node:assert/strict";
import test from "node:test";
import type { RawStorageS3Config } from "../../packages/storage/src/s3.js";
import type { MachineSessionIdentity } from "../../packages/storage/src/session-credentials.js";
import { buildWebhookRawObjectKey,type WebhookRawWriteInput } from "../../packages/storage/src/webhook-raw.js";
import {
  LeaseBoundWebhookRawWriter,
  type RawStorageWebhookSessionControl,
  type WebhookScopedObjectStoreFactory,
} from "./src/raw-storage.js";

const config:RawStorageS3Config={
  endpoint:"https://example.storage.supabase.co/storage/v1/s3",
  authUrl:"https://example.supabase.co",region:"ap-southeast-2",accessKeyId:"example",
  legacyAnonKey:"header.payload.signature",machinePurpose:"webhook",
  machineEmail:"raw-storage-webhook@machine.albert.invalid",
  machinePassword:"webhook-machine-password-material-000001",bucket:"raw-payloads",
};
const identity:MachineSessionIdentity=Object.freeze({
  userId:"10000000-0000-4000-8000-000000000001",
  sessionId:"20000000-0000-4000-8000-000000000001",
  tokenExpiresAt:new Date(Date.now()+10*60_000),
});
const input:WebhookRawWriteInput=Object.freeze({
  tenantId:"01J90000000000000000000001",
  connectionId:"01J90000000000000000000002",
  receiptId:"01J90000000000000000000003",
  connectorKey:"deputy",
  receivedAt:"2026-08-03T00:00:00.000Z",
  body:new TextEncoder().encode("signed deputy bytes"),
  authority:{verificationReference:"01J90000000000000000000004"},
});

function factory(events:string[],fail=false):WebhookScopedObjectStoreFactory{
  return (scope,authorize)=>({
    async putIfAbsent(value){
      await authorize(identity);
      events.push(`s3:${value.key}`);
      assert.equal(value.key,scope.objectKey);
      if(fail)throw new Error("synthetic_webhook_s3_failure");
      return "created";
    },
    async read(){return null;},
    destroy(){events.push(`destroy:${scope.objectKey}`);},
  });
}

function control(events:string[],overrides:Partial<{
  connectionId:string;expiresAt:string;
}>={}):RawStorageWebhookSessionControl{
  return {
    async issueRawStorageWebhookSession(value){
      events.push(`issue:${value.receiptId}`);
      assert.equal(value.identity,identity);
      return {
        grantId:"01J90000000000000000000005",tenantId:value.tenantId,
        connectionId:overrides.connectionId??value.connectionId,
        objectKey:buildWebhookRawObjectKey(input),
        expiresAt:overrides.expiresAt??new Date(Date.now()+90_000).toISOString(),
      };
    },
    async revokeRawStorageWebhookSession(value){events.push(`revoke:${value.grantId}`);},
  };
}

test("webhook raw writer issues before S3 and revokes/destroys after success",async()=>{
  const events:string[]=[];
  const writer=new LeaseBoundWebhookRawWriter(config,control(events),undefined,factory(events));

  const receipt=await writer.put(input);

  assert.equal(receipt.objectKey,buildWebhookRawObjectKey(input));
  assert.ok(events[0]?.startsWith("issue:"));
  assert.ok(events[1]?.startsWith("s3:"));
  assert.deepEqual(events.slice(-2),[
    `destroy:${buildWebhookRawObjectKey(input)}`,
    "revoke:01J90000000000000000000005",
  ]);
});

test("webhook raw writer revokes and destroys on S3, scope, or expiry failure",async()=>{
  const cases=[
    {name:"s3",fail:true,overrides:{}},
    {name:"scope",fail:false,overrides:{connectionId:"01J90000000000000000000006"}},
    {name:"expiry",fail:false,overrides:{expiresAt:new Date(Date.now()+20*60_000).toISOString()}},
  ] as const;
  for(const candidate of cases){
    const events:string[]=[];
    const writer=new LeaseBoundWebhookRawWriter(
      config,control(events,candidate.overrides),undefined,factory(events,candidate.fail),
    );
    await assert.rejects(writer.put(input));
    assert.ok(events.some((event)=>event.startsWith("destroy:")),candidate.name);
    assert.ok(events.includes("revoke:01J90000000000000000000005"),candidate.name);
  }
});

test("parallel webhook receipts revoke only their own grants",async()=>{
  const events:string[]=[];
  const issued=new Map<string,string>();
  const parallelControl:RawStorageWebhookSessionControl={
    async issueRawStorageWebhookSession(value){
      const grantId=value.receiptId===input.receiptId
        ?"01J90000000000000000000007":"01J90000000000000000000008";
      issued.set(value.receiptId,grantId);
      return {grantId,tenantId:value.tenantId,connectionId:value.connectionId,
        objectKey:value.receiptId===input.receiptId
          ?buildWebhookRawObjectKey(input):buildWebhookRawObjectKey(second),
        expiresAt:new Date(Date.now()+90_000).toISOString()};
    },
    async revokeRawStorageWebhookSession(value){events.push(`revoke:${value.grantId}`);},
  };
  const second:WebhookRawWriteInput={...input,receiptId:"01J90000000000000000000009",
    body:new TextEncoder().encode("second signed deputy bytes")};
  const writer=new LeaseBoundWebhookRawWriter(config,parallelControl,undefined,factory(events));

  await Promise.all([writer.put(input),writer.put(second)]);

  assert.equal(issued.size,2);
  assert.deepEqual(events.filter((event)=>event.startsWith("revoke:")).sort(),[
    "revoke:01J90000000000000000000007",
    "revoke:01J90000000000000000000008",
  ]);
});

test("webhook raw writer attempts every refreshed grant revocation when one fails",async()=>{
  const grantIds=[
    "01J9000000000000000000000A",
    "01J9000000000000000000000B",
  ] as const;
  const revoked:string[]=[];
  let issued=0;
  const multiGrantControl:RawStorageWebhookSessionControl={
    async issueRawStorageWebhookSession(value){
      const grantId=grantIds[issued++];
      assert.ok(grantId);
      return {grantId,tenantId:value.tenantId,connectionId:value.connectionId,
        objectKey:buildWebhookRawObjectKey(input),
        expiresAt:new Date(Date.now()+90_000).toISOString()};
    },
    async revokeRawStorageWebhookSession(value){
      revoked.push(value.grantId);
      if(value.grantId===grantIds[0])throw new Error("synthetic_first_revoke_failure");
    },
  };
  const multiGrantFactory:WebhookScopedObjectStoreFactory=(_scope,authorize)=>({
    async putIfAbsent(){
      await authorize(identity);
      await authorize(identity);
      return "created";
    },
    async read(){return null;},
    destroy(){},
  });
  const writer=new LeaseBoundWebhookRawWriter(
    config,multiGrantControl,undefined,multiGrantFactory,
  );

  await assert.rejects(
    writer.put(input),
    /webhook_raw_storage_session_cleanup_failed/,
  );
  assert.deepEqual(revoked.sort(),[...grantIds].sort());
});
