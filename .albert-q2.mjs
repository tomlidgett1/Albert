import fs from "node:fs"; import pg from "pg";
const env={}; for(const l of fs.readFileSync("/Users/user/Documents/Albert/.env.local","utf8").split("\n")){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)env[m[1]]=m[2];}
const which=process.argv[2]==="control"?"CONTROL_PLANE_ADMIN_DATABASE_URL":"ANALYTICAL_ADMIN_DATABASE_URL";
const c=new pg.Client({connectionString:env[which]}); await c.connect();
await c.query(process.argv[2]==="control"?"set role albert_control_migration_owner":"set role albert_migration_owner");
if(process.argv[3]&&process.argv[3]!=="-") await c.query(`set albert.tenant_id='${process.argv[3].replace(/[^0-9A-Z]/g,"")}'`);
const r=await c.query(process.argv.slice(4).join(" "));
console.log(JSON.stringify(r.rows,null,1)); await c.end();
