import assert from "node:assert/strict";
import test from "node:test";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  S3RawObjectStore,
  WebhookRawWriter,
  loadRawStorageS3Config,
} from "../../packages/storage/src/index.js";

const tenantId="01J00000000000000000000001";
const connectionId="01J00000000000000000000002";
const receiptId="01J00000000000000000000003";
const key=`tenant/${tenantId}/connection/${connectionId}/stream/sales/date/2026-08-03/batch-${receiptId}.jsonl.gz`;
const config={endpoint:"https://project.storage.supabase.co/storage/v1/s3",region:"ap-southeast-2",accessKeyId:"storage-access-key",secretAccessKey:"storage-secret-key-value",bucket:"raw-payloads" as const};

test("S3 raw adapter makes immutable conditional writes and scopes every key",async()=>{
  const calls:unknown[]=[];
  const client={async send(command:unknown){calls.push(command);if(command instanceof GetObjectCommand)return{Body:{async transformToByteArray(){return new Uint8Array([1,2,3]);}}};return{};},destroy(){}} as unknown as S3Client;
  const store=new S3RawObjectStore(config,client);
  await store.ready();
  assert.equal(await store.putIfAbsent({key,body:new Uint8Array([1,2,3]),contentType:"application/gzip",metadata:{sha256:"a".repeat(64)}}),"created");
  assert.deepEqual(await store.read(key),new Uint8Array([1,2,3]));
  assert.ok(calls[0] instanceof HeadBucketCommand);
  assert.ok(calls[1] instanceof PutObjectCommand);
  assert.equal((calls[1] as PutObjectCommand).input.IfNoneMatch,"*");
  assert.equal((calls[1] as PutObjectCommand).input.Bucket,"raw-payloads");
  await assert.rejects(()=>store.read(`other/${key}`),/outside the governed tenant prefix/);
});

test("S3 raw adapter treats 412 as an existing immutable object and supports verified purge primitives",async()=>{
  const calls:unknown[]=[];
  const client={async send(command:unknown){calls.push(command);if(command instanceof PutObjectCommand)throw Object.assign(new Error("precondition"),{$metadata:{httpStatusCode:412}});if(command instanceof ListObjectsV2Command)return{Contents:[{Key:key}],IsTruncated:false};if(command instanceof DeleteObjectsCommand)return{};return{};},destroy(){}} as unknown as S3Client;
  const store=new S3RawObjectStore(config,client);
  assert.equal(await store.putIfAbsent({key,body:new Uint8Array([1]),contentType:"application/gzip",metadata:{}}),"exists");
  const page=await store.listPrefix(`tenant/${tenantId}/connection/${connectionId}/`);
  assert.deepEqual(page.keys,[key]);
  await store.deleteKeys(page.keys);
  assert.ok(calls.some((command)=>command instanceof DeleteObjectsCommand));
  await assert.rejects(()=>store.listPrefix("tenant/not-a-tenant/"),/outside the governed tenant scope/);
});

test("webhook retries verify exact immutable bytes instead of accepting a key collision",async()=>{
  let body:Uint8Array|undefined;
  const store={
    async putIfAbsent(input:{body:Uint8Array}){body=input.body;return"exists" as const;},
    async read(){return body??null;},
  };
  const writer=new WebhookRawWriter(store);
  const receipt=await writer.put({tenantId,connectionId,receiptId,connectorKey:"xero",receivedAt:"2026-08-03T10:00:00.000Z",body:new TextEncoder().encode("signed vendor bytes")});
  assert.match(receipt.objectKey,/webhook_xero/);
  const conflicting=new WebhookRawWriter({async putIfAbsent(){return"exists" as const;},async read(){return new Uint8Array([0]);}});
  await assert.rejects(()=>conflicting.put({tenantId,connectionId,receiptId,connectorKey:"xero",receivedAt:"2026-08-03T10:00:00.000Z",body:new TextEncoder().encode("different")}),/webhook_raw_conflict/);
});

test("S3 configuration rejects generic URLs and missing scoped credentials",()=>{
  const environment={SUPABASE_STORAGE_S3_ENDPOINT:config.endpoint,SUPABASE_STORAGE_S3_REGION:config.region,SUPABASE_STORAGE_S3_ACCESS_KEY_ID:config.accessKeyId,SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY:config.secretAccessKey};
  assert.deepEqual(loadRawStorageS3Config(environment),config);
  assert.throws(()=>loadRawStorageS3Config({...environment,SUPABASE_STORAGE_S3_ENDPOINT:"https://project.supabase.co"}),/S3 endpoint/);
});
