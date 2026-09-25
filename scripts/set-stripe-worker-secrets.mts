/**
 * Push STRIPE_CLIENT_ID and STRIPE_SECRET_KEY from .env.local onto the
 * dogfood sync worker without printing values. Fill those names in
 * .env.local first. Register
 * https://albert-chi.vercel.app/api/oauth/stripe/callback
 * on the Stripe Connect platform app.
 *
 * Run: node --env-file=.env.local --import tsx scripts/set-stripe-worker-secrets.mts
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const app = "albert-sync-worker-dogfood";
const clientId = process.env.STRIPE_CLIENT_ID?.trim() ?? "";
const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";

if (clientId.length < 8 || secretKey.length < 8) {
  console.error("Stripe Connect keys are not set in .env.local. Fill STRIPE_CLIENT_ID and STRIPE_SECRET_KEY, then re-run.");
  process.exit(2);
}
if (!clientId.startsWith("ca_")) {
  console.error("STRIPE_CLIENT_ID must be a Stripe Connect client id.");
  process.exit(2);
}
if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) {
  console.error("STRIPE_SECRET_KEY is test mode. Albert's Fivetran Stripe connector is live mode only.");
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), "albert-stripe-secrets-"));
const file = join(dir, "secrets.env");
await writeFile(file, `STRIPE_CLIENT_ID=${clientId}\nSTRIPE_SECRET_KEY=${secretKey}\n`, { mode: 0o600 });

const child = spawn("fly", ["secrets", "import", "-a", app], {
  stdio: ["pipe", "inherit", "inherit"],
});
const { createReadStream } = await import("node:fs");
createReadStream(file).pipe(child.stdin!);
const code = await new Promise<number>((resolve) => {
  child.on("exit", (exitCode) => resolve(exitCode ?? 1));
});
await rm(dir, { recursive: true, force: true });
if (code === 0) console.log("Stripe Connect secrets are on", app, ". Check /readyz stripeConfigured.");
process.exit(code);
