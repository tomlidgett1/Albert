
import { loadRawStorageS3Config } from "../packages/storage/src/s3.ts";
import { SupabaseMachineSessionPool } from "../packages/storage/src/session-credentials.ts";
const config = loadRawStorageS3Config(process.env as any, {
  machinePurpose: "sync",
  passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
});
const pool = new SupabaseMachineSessionPool(config);
const session = await pool.getSession();
const payload = JSON.parse(Buffer.from(session.accessToken.split(".")[1], "base64url").toString("utf8"));
console.log(JSON.stringify({
  sub: payload.sub,
  role: payload.role,
  session_id: payload.session_id,
  aud: payload.aud,
  app_metadata: payload.app_metadata,
  exp: payload.exp,
  userId: session.userId,
  sessionId: session.sessionId,
}, null, 2));
