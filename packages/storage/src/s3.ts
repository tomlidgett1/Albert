import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { RawObjectStore } from "./raw-batch.js";

const RAW_BUCKET = "raw-payloads";
const SAFE_REGION = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u;
const SAFE_RAW_KEY = /^tenant\/[0-9A-HJKMNP-TV-Z]{26}(?:\/[A-Za-z0-9._-]+)+$/u;

export type RawStorageS3Config = Readonly<{
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: typeof RAW_BUCKET;
}>;

export type RawStoragePage = Readonly<{
  keys: readonly string[];
  continuationToken?: string;
}>;

export function loadRawStorageS3Config(source: Readonly<Record<string,string|undefined>> = process.env): RawStorageS3Config {
  const endpoint = required(source,"SUPABASE_STORAGE_S3_ENDPOINT");
  let parsed: URL;
  try { parsed = new URL(endpoint); }
  catch { throw new Error("SUPABASE_STORAGE_S3_ENDPOINT is not a valid URL."); }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
    !parsed.pathname.endsWith("/storage/v1/s3")
  ) throw new Error("SUPABASE_STORAGE_S3_ENDPOINT must be the HTTPS S3 endpoint from Supabase Storage settings.");
  const region = required(source,"SUPABASE_STORAGE_S3_REGION");
  if (!SAFE_REGION.test(region)) throw new Error("SUPABASE_STORAGE_S3_REGION is invalid.");
  const accessKeyId = required(source,"SUPABASE_STORAGE_S3_ACCESS_KEY_ID");
  const secretAccessKey = required(source,"SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY");
  if (accessKeyId.length > 256 || Buffer.byteLength(secretAccessKey,"utf8") < 16 || secretAccessKey.length > 512) {
    throw new Error("Supabase Storage S3 credentials are malformed.");
  }
  return Object.freeze({endpoint:parsed.toString().replace(/\/$/u,""),region,accessKeyId,secretAccessKey,bucket:RAW_BUCKET});
}

/**
 * Immutable raw-object adapter using storage-only S3 credentials. Supabase S3
 * access keys bypass Storage RLS, but unlike a service-role JWT they cannot
 * query Auth or control-plane tables. Deploy each process with its own pair.
 */
export class S3RawObjectStore implements RawObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly config: RawStorageS3Config,
    client?: S3Client,
  ) {
    if (config.bucket !== RAW_BUCKET) throw new Error("Raw objects must use raw-payloads.");
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      maxAttempts: 3,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async ready(): Promise<void> {
    await this.client.send(new HeadBucketCommand({Bucket:this.config.bucket}));
  }

  async putIfAbsent(input: Parameters<RawObjectStore["putIfAbsent"]>[0]): Promise<"created" | "exists"> {
    assertRawKey(input.key);
    for (let attempt=1;attempt<=3;attempt+=1) {
      try {
        await this.client.send(new PutObjectCommand({
          Bucket:this.config.bucket,
          Key:input.key,
          Body:input.body,
          CacheControl:"private, max-age=31536000, immutable",
          ContentType:input.contentType,
          Metadata:{...input.metadata},
          IfNoneMatch:"*",
        }));
        return "created";
      } catch (error) {
        const status=httpStatus(error);
        if (status===412)return"exists";
        if (status===409&&attempt<3)continue;
        throw new Error(`Immutable raw upload failed (${safeStorageCode(error)}).`);
      }
    }
    throw new Error("Immutable raw upload failed (conditional_conflict).");
  }

  async read(key:string):Promise<Uint8Array|null>{
    assertRawKey(key);
    try{
      const result=await this.client.send(new GetObjectCommand({Bucket:this.config.bucket,Key:key}));
      if(!result.Body)throw new Error("empty_body");
      return new Uint8Array(await result.Body.transformToByteArray());
    }catch(error){
      if(httpStatus(error)===404||errorName(error)==="NoSuchKey")return null;
      throw new Error(`Immutable raw download failed (${safeStorageCode(error)}).`);
    }
  }

  async listPrefix(prefix:string,continuationToken?:string):Promise<RawStoragePage>{
    assertRawPrefix(prefix);
    const result=await this.client.send(new ListObjectsV2Command({
      Bucket:this.config.bucket,Prefix:prefix,MaxKeys:1_000,
      ...(continuationToken?{ContinuationToken:continuationToken}:{}),
    }));
    const keys=(result.Contents??[]).flatMap((item)=>typeof item.Key==="string"?[item.Key]:[]);
    for(const key of keys)assertRawKey(key);
    return Object.freeze({keys:Object.freeze(keys),...(result.IsTruncated&&result.NextContinuationToken?{continuationToken:result.NextContinuationToken}:{})});
  }

  async deleteKeys(keys:readonly string[]):Promise<void>{
    if(keys.length<1||keys.length>1_000)throw new Error("Raw object deletion batch must contain 1 to 1000 keys.");
    for(const key of keys)assertRawKey(key);
    const result=await this.client.send(new DeleteObjectsCommand({
      Bucket:this.config.bucket,
      Delete:{Quiet:true,Objects:keys.map((Key)=>({Key}))},
    }));
    if(result.Errors?.length){
      const code=result.Errors[0]?.Code?.replaceAll(/[^A-Za-z0-9_.-]/gu,"_")||"delete_error";
      throw new Error(`Raw object deletion failed (${code}).`);
    }
  }

  destroy():void{this.client.destroy();}
}

function required(source:Readonly<Record<string,string|undefined>>,name:string):string{
  const value=source[name]?.trim();if(!value)throw new Error(`${name} is required.`);return value;
}
function assertRawKey(value:string):void{
  if(value.length>1_024||!SAFE_RAW_KEY.test(value)||value.includes(".."))throw new Error("Raw storage object key is outside the governed tenant prefix.");
}
function assertRawPrefix(value:string):void{
  if(!/^tenant\/[0-9A-HJKMNP-TV-Z]{26}(?:\/connection\/[0-9A-HJKMNP-TV-Z]{26})?\/?$/u.test(value))throw new Error("Raw storage prefix is outside the governed tenant scope.");
}
function httpStatus(error:unknown):number|undefined{
  if(!error||typeof error!=="object")return undefined;
  const metadata=(error as {$metadata?:unknown}).$metadata;
  if(!metadata||typeof metadata!=="object")return undefined;
  const status=(metadata as {httpStatusCode?:unknown}).httpStatusCode;
  return typeof status==="number"?status:undefined;
}
function errorName(error:unknown):string|undefined{return error instanceof Error?error.name:undefined;}
function safeStorageCode(error:unknown):string{
  const status=httpStatus(error);if(status)return`http_${status}`;
  const name=errorName(error);return name?.replaceAll(/[^A-Za-z0-9_.-]/gu,"_")||"storage_error";
}
