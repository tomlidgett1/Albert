import { createHmac, sign, type KeyObject } from "node:crypto";
import { resultFromClaim } from "./contracts.js";
import { runLiveIdentityProbe, type ProbeTransport } from "./probes.js";
import type { PostgresVendorAttestationStore } from "./store.js";

export class VendorConnectionAttestorService {
  constructor(private readonly dependencies: Readonly<{
    store: Pick<PostgresVendorAttestationStore, "claim" | "prepare" | "complete">;
    signingKey: KeyObject;
    keyId: string;
    toolRef: string;
    buildDigest: string;
    admissionHmacKey: Buffer;
    transport?: ProbeTransport;
  }>) {}

  async attest(challengeId: string, nonce: string, accessToken: Buffer) {
    try {
      const claim = await this.dependencies.store.claim(challengeId, nonce);
      const outcome = await runLiveIdentityProbe(
        claim,
        accessToken,
        this.dependencies.transport,
      );
      const binding = resultFromClaim(claim, outcome, {
        keyId: this.dependencies.keyId,
        toolRef: this.dependencies.toolRef,
        buildDigest: this.dependencies.buildDigest,
      });
      const digest = await this.dependencies.store.prepare(challengeId, binding);
      const signature = Buffer.from(sign(
        null,
        Buffer.from(digest, "hex"),
        this.dependencies.signingKey,
      )).toString("base64url");
      const admissionMac = createHmac("sha256", this.dependencies.admissionHmacKey)
        .update(Buffer.from(digest, "hex")).digest("hex");
      const result = await this.dependencies.store.complete(
        challengeId,
        binding,
        digest,
        signature,
        admissionMac,
      );
      return Object.freeze({ ...result, passed: outcome.status === "passed" });
    } finally {
      accessToken.fill(0);
    }
  }
}
