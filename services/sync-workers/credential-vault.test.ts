import assert from "node:assert/strict";
import test from "node:test";
import { AesKeyWrapper, EnvelopeCryptography, parseOAuthCredentialSecret } from "./src/credential-vault.js";

test("vault contract accepts StripeAccount credentials used by Fivetran Stripe", () => {
  const secret = parseOAuthCredentialSecret({
    provider: "stripe",
    accessToken: "acct_testmerchant",
    tokenType: "StripeAccount",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    scopes: ["read_write"],
    metadata: { stripeUserId: "acct_testmerchant", stripeAccessToken: "rk_live_restrictedkey" },
  });
  assert.equal(secret.tokenType, "StripeAccount");
  assert.equal(secret.provider, "stripe");
});

test("credential envelopes use independent DEKs and authenticate tenant/reference/version AAD", async () => {
  const crypto = new EnvelopeCryptography(new AesKeyWrapper(
    Buffer.alloc(32, 7).toString("base64url"),
    "env:TOKEN_ENCRYPTION_KEY",
    "v1",
  ));
  const binding = { tenantId: "01J00000000000000000000001", secretReference: "oauth_ref", version: 1 };
  const first = await crypto.seal("same-token", binding);
  const second = await crypto.seal("same-token", binding);
  assert.equal(first.nonce.byteLength, 12);
  assert.equal(first.authenticationTag.byteLength, 16);
  assert.notDeepEqual(first.wrappedDataKey, second.wrappedDataKey);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(await crypto.open(first, binding), "same-token");
  await assert.rejects(
    crypto.open(first, { ...binding, tenantId: "01J00000000000000000000009" }),
    /binding does not match/,
  );
  await assert.rejects(
    crypto.open({ ...first, authenticationTag: new Uint8Array(16) }, binding),
  );
});
