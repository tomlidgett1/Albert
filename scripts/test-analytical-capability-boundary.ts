import assert from "node:assert/strict";
import { Client } from "pg";

const TENANT_A="01H00000000000000000000901";
const TENANT_B="01H00000000000000000000902";
const TENANT_C="01H00000000000000000000903";
const NONCES=[
  "01H00000000000000000000911",
  "01H00000000000000000000912",
  "01H00000000000000000000913",
  "01H00000000000000000000914",
  "01H00000000000000000000915",
  "01H00000000000000000000916",
  "01H00000000000000000000917",
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
  const metadata=new Client({
    connectionString:runtimeUrl(adminUrl,"albert_semantic_metadata_runtime",required("ALBERT_SEMANTIC_METADATA_DB_PASSWORD")),
    application_name:"albert-capability-boundary-test/semantic-metadata",
  });
  await Promise.all([admin.connect(),transform.connect(),deletion.connect(),metadata.connect()]);
  try{
    await assert.rejects(
      transaction(transform,"transform_rw",async()=>{
        await transform.query("select set_config('albert.tenant_id',$1,true)",[TENANT_B]);
        await transform.query("select core.current_tenant_id()");
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
      const result=await transform.query<{tenant_id:string}>("select core.current_tenant_id() as tenant_id");
      assert.equal(result.rows[0]?.tenant_id,TENANT_A);
      // Exercise the exact production LOGIN, signed tenant capability, RLS,
      // canonical ULID CHECK, and currency CHECK together. Function ACL
      // hardening must not make transform_rw unable to perform its declared
      // canonical writes.
      await transform.query(
        `insert into core.legal_entity(
           tenant_id,id,name,base_currency,active,sync_run_id
         ) values($1,$2,$3,$4,true,$5)
         on conflict(tenant_id,id) do nothing`,
        [
          TENANT_A,"01H00000000000000000000931","Capability boundary entity",
          "AUD","01H00000000000000000000932",
        ],
      );
      const inserted=await transform.query<{count:string}>(
        "select count(*)::text as count from core.legal_entity where tenant_id=$1 and id=$2",
        [TENANT_A,"01H00000000000000000000931"],
      );
      assert.equal(Number(inserted.rows[0]?.count),1);
    });

    await admin.query("begin");
    try{
      await admin.query("set local role albert_migration_owner");
      await admin.query("select set_config('albert.tenant_id',$1,true)",[TENANT_A]);
      await admin.query(
        `insert into quality.pipeline_stats(
           tenant_id,snapshot_at,domain,source_rows,canonical_rows,rejected_rows,
           observed_entities,linked_entities,source_watermarks,invariant_status
         ) values
           ($1,date_trunc('hour',statement_timestamp())-interval '2 hours'+interval '10 minutes','canonical',1,1,0,1,1,'{}','{}'),
           ($1,date_trunc('hour',statement_timestamp())-interval '2 hours'+interval '20 minutes','canonical',2,2,0,2,2,'{}','{}'),
           ($1,statement_timestamp()-interval '401 days','canonical',3,3,0,3,3,'{}','{}')`,
        [TENANT_A],
      );
      await admin.query(
        `insert into semantic_internal.pipeline_stats_projection_outbox(
           tenant_id,snapshot_at,domain,source_rows,canonical_rows,rejected_rows,
           observed_entities,linked_entities,source_watermarks,invariant_status
         ) values($1,statement_timestamp(),'canonical',1,1,0,1,1,'{}','{}')`,
        [TENANT_A],
      );
      await admin.query("commit");
    }catch(error){
      await admin.query("rollback").catch(()=>undefined);
      throw error;
    }
    await transaction(transform,"transform_rw",async()=>{
      await transform.query("select set_config('albert.tenant_capability',$1,true)",[transformToken]);
      const retained=await transform.query<{
        result:Readonly<Record<string,number>>;
      }>("select semantic_internal.retain_pipeline_history($1) as result",[TENANT_A]);
      assert.deepEqual(retained.rows[0]?.result,{
        pipeline_stats_removed:2,
        legacy_outbox_removed:1,
        projection_rows_removed:0,
        hourly_retention_hours:48,
        daily_retention_days:35,
        maximum_retention_days:400,
      });
      const remaining=await transform.query<{row_count:string}>(
        "select count(*)::text as row_count from quality.pipeline_stats where tenant_id=$1 and domain='canonical'",
        [TENANT_A],
      );
      assert.equal(remaining.rows[0]?.row_count,"1");
    });

    const wrongAudience=await signedToken(admin,{
      tenantId:TENANT_A,audience:"analytical:ingest",scope:"ingest",
      subject:"test:wrong-audience",nonce:NONCES[1],evidence:{kind:"test"},
    });
    await assert.rejects(
      transaction(transform,"transform_rw",async()=>{
        await transform.query("select set_config('albert.tenant_capability',$1,true)",[wrongAudience]);
        await transform.query("select core.current_tenant_id()");
      }),
      (error:unknown)=>(error as {code?:string}).code==="42501",
      "an ingest token must not cross into transform",
    );

    const tampered=JSON.parse(transformToken) as {payload:{tenant_id:string};signature:string};
    tampered.payload.tenant_id=TENANT_B;
    await assert.rejects(
      transaction(transform,"transform_rw",async()=>{
        await transform.query("select set_config('albert.tenant_capability',$1,true)",[JSON.stringify(tampered)]);
        await transform.query("select core.current_tenant_id()");
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
        await transform.query("select core.current_tenant_id()");
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

    // Semantic promotion recovery is tenant-capability scoped and exposes
    // only fixed lease RPCs. The metadata login has no direct outbox access.
    const promotionCandidate="01H00000000000000000000921";
    const promotionQuery="01H00000000000000000000922";
    const promotionConnection="01H00000000000000000000923";
    await admin.query("begin");
    try{
      await admin.query("set local role albert_migration_owner");
      await admin.query("select set_config('albert.tenant_id',$1,true)",[TENANT_A]);
      await admin.query(
        `insert into semantic_internal.promotion_candidate_outbox(
           tenant_id,candidate_id,query_id,connection_id,connector_id,
           source_table,source_fields,question_digest,requested_metric_concept
         ) values($1,$2,$3,$4,'xero','invoices',array['reference'],$5,$6)`,
        [TENANT_A,promotionCandidate,promotionQuery,promotionConnection,"c".repeat(64),"finance.invoice_reference"],
      );
      await admin.query("commit");
    }catch(error){
      await admin.query("rollback").catch(()=>undefined);
      throw error;
    }
    const metadataToken=await signedToken(admin,{
      tenantId:TENANT_A,audience:"analytical:semantic-metadata",scope:"semantic_metadata",
      subject:"test:semantic-promotion",nonce:NONCES[5],evidence:{kind:"test"},
    });
    await assert.rejects(
      transaction(metadata,"semantic_meta_rw",async()=>{
        await metadata.query("select set_config('albert.tenant_capability',$1,true)",[metadataToken]);
        await metadata.query("select * from semantic_internal.promotion_candidate_outbox");
      }),
      (error:unknown)=>(error as {code?:string}).code==="42501",
      "semantic metadata runtime must not read the outbox directly",
    );
    await transaction(metadata,"semantic_meta_rw",async()=>{
      await metadata.query("select set_config('albert.tenant_capability',$1,true)",[metadataToken]);
      const claimed=await metadata.query<{
        claim_status:string;candidate_id:string;candidate_digest:string;attempt_count:number;
      }>(
        "select * from semantic_internal.claim_promotion_candidate($1,$2,$3,$4)",
        [promotionCandidate,"semantic-relay:capability-test","01H00000000000000000000924",90],
      );
      assert.deepEqual(
        {
          status:claimed.rows[0]?.claim_status,
          candidateId:claimed.rows[0]?.candidate_id,
          digestShape:/^[a-f0-9]{64}$/.test(claimed.rows[0]?.candidate_digest??""),
          attemptCount:Number(claimed.rows[0]?.attempt_count),
        },
        {status:"claimed",candidateId:promotionCandidate,digestShape:true,attemptCount:1},
      );
      await metadata.query(
        "select semantic_internal.complete_promotion_candidate($1,$2,$3,$4)",
        [promotionCandidate,"semantic-relay:capability-test","01H00000000000000000000924","01H00000000000000000000925"],
      );
      const replay=await metadata.query<{claim_status:string;control_inbox_item_id:string}>(
        "select * from semantic_internal.claim_promotion_candidate($1,$2,$3,$4)",
        [promotionCandidate,"semantic-relay:capability-test","01H00000000000000000000926",90],
      );
      assert.deepEqual(replay.rows[0],{
        claim_status:"delivered",
        candidate_id:promotionCandidate,
        query_id:promotionQuery,
        connection_id:promotionConnection,
        connector_id:"xero",
        source_table:"invoices",
        source_fields:["reference"],
        question_digest:"c".repeat(64),
        requested_metric_concept:"finance.invoice_reference",
        candidate_digest:claimed.rows[0]?.candidate_digest,
        attempt_count:1,
        control_inbox_item_id:"01H00000000000000000000925",
      });
    });
    const wrongTenantMetadataToken=await signedToken(admin,{
      tenantId:TENANT_C,audience:"analytical:semantic-metadata",scope:"semantic_metadata",
      subject:"test:wrong-semantic-promotion-tenant",nonce:NONCES[6],evidence:{kind:"test"},
    });
    await assert.rejects(
      transaction(metadata,"semantic_meta_rw",async()=>{
        await metadata.query("select set_config('albert.tenant_capability',$1,true)",[wrongTenantMetadataToken]);
        await metadata.query(
          "select * from semantic_internal.claim_promotion_candidate($1,$2,$3,$4)",
          [promotionCandidate,"semantic-relay:capability-test","01H00000000000000000000927",90],
        );
      }),
      (error:unknown)=>(error as {code?:string}).code==="P0002",
      "a signed capability for another tenant must not claim the candidate",
    );
  }finally{
    await Promise.allSettled([admin.end(),transform.end(),deletion.end(),metadata.end()]);
  }
  process.stdout.write("analytical capability exact-login boundary passed\n");
}

await main();
