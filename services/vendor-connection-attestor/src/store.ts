import type { Pool, PoolClient } from "pg";
import {
  vendorAttestorClaimSchema,
  type VendorAttestorClaim,
  type VendorResultBinding,
} from "./contracts.js";

type JsonRow = Readonly<{ value: unknown }>;

export class PostgresVendorAttestationStore {
  constructor(private readonly pool: Pool) {}

  async ready(): Promise<boolean> {
    return await this.withRole(async (client) => {
      const result = await client.query<{ ready: boolean }>(
        "select control_plane.assert_live_vendor_attestation_boundary_ready() as ready",
      );
      return result.rows[0]?.ready === true;
    });
  }

  async claim(challengeId: string, nonce: string): Promise<VendorAttestorClaim> {
    return await this.withRole(async (client) => {
      const result = await client.query<JsonRow>(
        "select control_plane.claim_live_vendor_connection_attestation($1,$2) as value",
        [challengeId, nonce],
      );
      return vendorAttestorClaimSchema.parse(result.rows[0]?.value);
    });
  }

  async prepare(challengeId: string, binding: VendorResultBinding): Promise<string> {
    return await this.withRole(async (client) => {
      const result = await client.query<{ digest: string }>(
        "select control_plane.prepare_live_vendor_connection_attestation_result($1,$2::jsonb) as digest",
        [challengeId, JSON.stringify(binding)],
      );
      const digest = result.rows[0]?.digest;
      if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) {
        throw new Error("vendor_result_digest_invalid");
      }
      return digest;
    });
  }

  async complete(
    challengeId: string,
    binding: VendorResultBinding,
    digest: string,
    signature: string,
    admissionMac: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withRole(async (client) => {
      const result = await client.query<JsonRow>(
        "select control_plane.complete_live_vendor_connection_attestation($1,$2::jsonb,$3,$4,$5) as value",
        [challengeId, JSON.stringify(binding), digest, signature, admissionMac],
      );
      const value = result.rows[0]?.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("vendor_result_completion_invalid");
      }
      return value as Readonly<Record<string, unknown>>;
    });
  }

  private async withRole<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role albert_vendor_connection_attestor");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
