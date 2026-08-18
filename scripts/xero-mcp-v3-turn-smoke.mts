/** Live end-to-end smoke: runs a real Albert v3 turn (same call as /api/v3-conversation) for the Ashburton Cycles owner against the configured sync worker + OpenAI, printing the trace. Usage: npx tsx scripts/xero-mcp-v3-turn-smoke.mts "give me our balance sheet as at 30 June" */
import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import { runAlbertV3Turn } from "../packages/albert-v3/src/index.js";
import { normalizeAgentPreferences } from "../packages/shared/src/index.js";
import { xeroMcpServiceUrl } from "../packages/xero-mcp/src/client.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";
const T="01KZN20VTX2EWW1TQ2AA3MCPW6";
for (const l of readFileSync(".env.local","utf8").split("\n")){const m=/^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(l);if(!m)continue;let x=m[2]!;if(/^".*"$|^'.*'$/.test(x))x=x.slice(1,-1);process.env[m[1]!]??=x;}
const v=process.env as Record<string,string>;
const u=new URL(v.CONTROL_PLANE_MIGRATION_URL||v.CONTROL_PLANE_ADMIN_DATABASE_URL!);const d=/^db\.([a-z0-9]+)\.supabase\.co$/u.exec(u.hostname);if(d){u.hostname="aws-0-ap-southeast-2.pooler.supabase.com";u.port="5432";if(!decodeURIComponent(u.username).endsWith(`.${d[1]}`))u.username=`${decodeURIComponent(u.username)}.${d[1]}`;}
const db=new PgTransactionalDatabase(u.toString(),{applicationName:"probe",assumedRole:"albert_control_migration_owner",maxConnections:1});
const o=await db.query<{user_id:string}>(`select user_id::text as user_id from control_plane.memberships where tenant_id=$1 and status='active' and role='owner' limit 1`,[T]);
const c=await db.query<{connector_key:string}>(`select distinct connector_key from control_plane.connections where tenant_id=$1 and status in ('connected','degraded')`,[T]);
const activeConnectors=c.rows.map(r=>r.connector_key);
console.log("activeConnectors:",activeConnectors.join(","),"xeroMcpUrl:",xeroMcpServiceUrl());
const message=process.argv[2] ?? "give me our P&L ytd calendar year";
const t0=Date.now(); let seq=0;
const result=await runAlbertV3Turn({
  message, conversation:[{role:"user",text:message}],
  preferences: normalizeAgentPreferences({model:"gpt-5.6-luna",reasoningEffort:"high",fastMode:true}),
  tenantId:T, actorId:o.rows[0]!.user_id, role:"owner", activeConnectors,
  conversationId:ulid(), turnId:ulid(),
  cubeApiUrl:v.CUBE_API_URL, cubeApiSecret:v.CUBEJS_API_SECRET,
  shopifyQLServiceUrl:v.SYNC_WORKER_INTERNAL_URL, shopifyQLSigningSecret:v.ALBERT_SHOPIFYQL_SIGNING_SECRET,
  shopifyAdminServiceUrl:v.SYNC_WORKER_INTERNAL_URL, shopifyAdminSigningSecret:v.ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET,
  xeroMcpServiceUrl:xeroMcpServiceUrl(), xeroMcpSigningSecret:v.ALBERT_OAUTH_WORKER_SIGNING_SECRET,
  openaiApiKey:v.OPENAI_API_KEY,
  emit: async (e:any)=>{ const t=((Date.now()-t0)/1000).toFixed(1); seq+=1; const event={...e,id:ulid(),sequence:seq,occurredAt:new Date().toISOString()};
    if(e.type==="progress") console.log(`[${t}s] progress ${e.stage}/${e.status}: ${e.label} — ${e.detail??""}`);
    else if(e.type==="query") console.log(`[${t}s] QUERY ${e.view}: ${e.topic} rows=${e.rowCount}`);
    else if(e.type==="answer") console.log(`[${t}s] ANSWER state=${e.state}\n${e.text}`);
    else if(e.type==="narrative") console.log(`[${t}s] narrative: ${e.text}`);
    else if(e.type==="plan") console.log(`[${t}s] plan: ${e.steps.map((s:any)=>s.status+":"+s.label).join(" | ")}`);
    else if(e.type==="table") console.log(`[${t}s] TABLE presentation=${e.presentation??"evidence"} rows=${e.rows.length} cols=${e.columns.map((c:any)=>c.label).join("|")} :: ${e.caption}`);
    else console.log(`[${t}s] ${e.type}`); return event; },
});
console.log("RESULT", JSON.stringify({state:result.answerState, queries:result.queriesExecuted, ms:Date.now()-t0}));
process.exit(0);
