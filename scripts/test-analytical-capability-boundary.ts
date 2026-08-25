import assert from "node:assert/strict";
import { Client } from "pg";

const TENANT_A="01H00000000000000000000901";
const TENANT_B="01H00000000000000000000902";
const NONCES=[
  "01H00000000000000000000911",
  "01H00000000000000000000912",
  "01H00000000000000000000913",
  "01H00000000000000000000914",
  "01H00000000000000000000915",
] as const;

function required(name:string):string{
  const value=process.env[name]?.trim();
  if(!value)throw new Error(`${name} is required.`);
  return value;
}

function runtimeUrl(adminUrl:string,login:string,password:string):string{
  const parsed=new URL(adminUrl);
  if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname)){
    throw new Error("The analytical capability boundary test is CI-local only.");
  }
  parsed.username=login;
  parsed.password=password;
  return parsed.toString();
}

async function signedToken(
  admin:Client,
  claims:Readonly<{
    tenantId:string;audience:string;scope:string;subject:string;nonce:string;
    evidence?:Readonly<Record<string,unknown>>;
  }>,
):Promise<string>{
  await admin.query("begin");
  try{
    await admin.query("set local role albert_migration_owner");
    const result=await admin.query<{token:string}>(
      `with selected_key as (
         select * from capability_internal.verification_keys
          where active_at<=clock_timestamp() and retire_at>clock_timestamp()+interval '5 minutes'
          order by active_at desc,key_id desc limit 1
       ), claims as (
         select jsonb_build_object(
           'version',1,'key_id',selected_key.key_id,'tenant_id',$1::text,
           'audience',$2::text,'scope',$3::text,'subject',$4::text,'nonce',$5::text,
           'issued_at',floor(extract(epoch from clock_timestamp()))::bigint,
           'expires_at',floor(extract(epoch from clock_timestamp()+interval '2 minutes'))::bigint,
           'evidence',$6::jsonb
         ) as payload,selected_key.secret
         from selected_key
       )
       select jsonb_build_object(
         'payload',payload,
         'signature',encode(extensions.hmac(convert_to(payload::text,'utf8'),secret,'sha256'),'hex')
       )::text as token from claims`,
      [
        claims.tenantId,claims.audience,claims.scope,claims.subject,claims.nonce,
        JSON.stringify(claims.evidence??{}),
      ],
    );
    await admin.query("commit");
    const token=result.rows[0]?.token;
    if(!token)throw new Error("test token signer returned no token");
    return token;
  }catch(error){
    await admin.query("rollback").catch(()=>undefined);
    throw error;
  }
}

async function transaction(client:Client,role:string,work:()=>Promise<void>):Promise<void>{
  await client.query("begin");
  try{
    await client.query(`set local role "${role}"`);
    await work();
    await client.query("commit");
  }catch(error){
    await client.query("rollback").catch(()=>undefined);
    throw error;
  }
}

async function main():Promise<void>{
  assert.equal(required("ALBERT_CAPABILITY_TEST_MODE"),"ci");
  const adminUrl=required("ANALYTICAL_ADMIN_DATABASE_URL");
  const admin=new Client({connectionString:adminUrl,application_name:"albert-capability-boundary-test/admin"});
  const transform=new Client({
    connectionString:runtimeUrl(adminUrl,"albert_transform_analytical_runtime",required("ALBERT_TRANSFORM_DB_PASSWORD")),
    application_name:"albert-capability-boundary-test/transform",
  });
  const deletion=new Client({
    connectionString:runtimeUrl(adminUrl,"albert_deletion_analytical_runtime",required("ALBERT_DELETION_DB_PASSWORD")),
    application_name:"albert-capability-boundary-test/deletion",
  });
  await Promise.all([admin.connect(),transform.connect(),deletion.connect()]);
  try{
    await assert.rejects(
      transaction(transform,"transform_rw",async()=>{
        await transform.query("select set_config('albert.tenant_id',$1,true)",[TENANT_B]);
        await transform.query("select ingestion.current_tenant_id()");
      }),
      (error:unknown)=>(error as {code?:string}).code==="42501",
      "a caller-selected tenant GUC must never authorize an exact runtime login",
    );

    const transformToken=await signedToken(admin,{
      tenantId:TENANT_A,audience:"analytical:transform",scope:"transform",
      subject:"test:transform",nonce:NONCES[0],evidence:{kind:"test"},
    });
    await transaction(transform,"transform_rw",async()=>{
      await transform.query("select set_config('albert.tenant_id',$1,true)",[TENANT_B]);
      await transform.query("select set_config('albert.tenant_capability',$1,true)",[transformToken]);
      const result=await transform.query<{tenant_id:string}>("select ingestion.current_tenant_id() as tenant_id");
      assert.equal(result.rows[0]?.tenant_id,TENANT_A);
      // V3 retired the canonical core tables. Exercise the exact production
      // LOGIN, signed tenant capability, source-table ACL and RLS together on
      // the current typed staging surface instead.
      const visible=await transform.query<{count:string}>(
        "select count(*)::text as count from source_xero.xero_currencies",
      );
      assert.equal(Number(visible.rows[0]?.count),0);
    });

    const wrongAudience=await signedToken(admin,{
      tenantId:TENANT_A,audience:"analytical:ingest",scope:"ingest",
      subject:"test:wrong-audience",nonce:NONCES[1],evidence:{kind:"test"},
    });
    await assert.rejects(
      transaction(transform,"transform_rw",async()=>{
        await transform.query("select set_config('albert.tenant_capability',$1,true)",[wrongAudience]);
        await transform.query("select ingestion.current_tenant_id()");
      }),
      (error:unknown)=>(error as {code?:string}).code==="42501",
      "an ingest token must not cross into transform",
    );

    const tampered=JSON.parse(transformToken) as {payload:{tenant_id:string};signature:string};
    tampered.payload.tenant_id=TENANT_B;
    await assert.rejects(
      transaction(transform,"transform_rw",async()=>{
        await transform.query("select set_config('albert.tenant_capability',$1,true)",[JSON.stringify(tampered)]);
        await transform.query("select ingestion.current_tenant_id()");
      }),
      (error:unknown)=>(error as {code?:string}).code==="42501",
      "a tenant claim mutation must invalidate the signature",
    );

    const deletionToken=await signedToken(admin,{
      tenantId:TENANT_A,audience:"analytical:deletion",scope:"deletion_purge",
      subject:"test:deletion",nonce:NONCES[2],
      evidence:{kind:"deletion_lease",operation:"purge"},
    });
    await deletion.query("begin");
    try{
      await deletion.query("set local role deletion_rw");
      await deletion.query("select set_config('albert.tenant_capability',$1,true)",[deletionToken]);
      await deletion.query("select capability_internal.activate_deletion_capability('deletion_purge')");
      await assert.rejects(
        deletion.query("select capability_internal.activate_deletion_capability('deletion_purge')"),
        (error:unknown)=>(error as {code?:string}).code==="42501",
      );
    }finally{
      await deletion.query("rollback").catch(()=>undefined);
    }

    const prePurgeTransformToken=await signedToken(admin,{
      tenantId:TENANT_B,audience:"analytical:transform",scope:"transform",
      subject:"test:pre-purge-transform",nonce:NONCES[3],evidence:{kind:"test"},
    });
    const tenantPurgeToken=await signedToken(admin,{
      tenantId:TENANT_B,audience:"analytical:deletion",scope:"deletion_purge",
      subject:"test:tenant-purge",nonce:NONCES[4],
      evidence:{kind:"deletion_lease",operation:"purge",request_scope:"tenant",connection_id:null},
    });
    await transaction(deletion,"deletion_rw",async()=>{
      await deletion.query("select set_config('albert.tenant_capability',$1,true)",[tenantPurgeToken]);
      const purged=await deletion.query<{result:{verified?:boolean;scope?:string}}>(
        "select deletion_internal.purge_tenant($1) as result",
        [TENANT_B],
      );
      assert.deepEqual(
        {verified:purged.rows[0]?.result.verified,scope:purged.rows[0]?.result.scope},
        {verified:true,scope:"tenant"},
      );
    });
    await admin.query("begin");
    let watermark:Readonly<{tenant_digest:string}>|undefined;
    try{
      await admin.query("set local role albert_migration_owner");
      const result=await admin.query<{tenant_digest:string}>(
        "select tenant_digest from capability_internal.tenant_revocation_watermarks",
      );
      assert.equal(result.rows.length,1);
      watermark=result.rows[0];
      await admin.query("commit");
    }catch(error){
      await admin.query("rollback").catch(()=>undefined);
      throw error;
    }
    assert.match(watermark?.tenant_digest??"",/^[a-f0-9]{64}$/);
    assert.notEqual(watermark?.tenant_digest,TENANT_B);
    await assert.rejects(
      transaction(transform,"transform_rw",async()=>{
        await transform.query("select set_config('albert.tenant_capability',$1,true)",[prePurgeTransformToken]);
        await transform.query("select ingestion.current_tenant_id()");
      }),
      (error:unknown)=>(error as {code?:string}).code==="42501",
      "a capability issued before purge must not authorize post-purge data recreation",
    );

    await transaction(transform,"transform_rw",async()=>{
      await assert.rejects(
        transform.query("select secret from capability_internal.verification_keys limit 1"),
        (error:unknown)=>(error as {code?:string}).code==="42501",
      );
    });

  }finally{
    await Promise.allSettled([admin.end(),transform.end(),deletion.end()]);
  }
  process.stdout.write("analytical capability exact-login boundary passed\n");
}

await main();
