import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import { asDeletionControl } from "./database-role.js";
import {
  deletionFailureEvidence,
  type DeletionFailureEvidence,
} from "./processor.js";

export type ShopifyPrivacyTopic = "customers/data_request" | "customers/redact";

export type ShopifyPrivacyClaim = Readonly<{
  messageId: number;
  readCount: number;
  visibilityDeadline: string;
  inboxId: string;
  topic: ShopifyPrivacyTopic;
  caseIds: readonly string[];
  completeBy: string;
}>;

export type ShopifyPrivacyProcessOutcome =
  | Readonly<{ status: "dispatched"; topic: ShopifyPrivacyTopic }>
  | Readonly<{
      status: "retry_scheduled" | "attention_required";
      failure: DeletionFailureEvidence;
      retryDelaySeconds: number;
    }>;

type ClaimRow = Readonly<{
  message_id: string | number;
  read_count: string | number;
  visibility_deadline: string | Date;
  inbox_id: unknown;
  topic: unknown;
  case_ids: unknown;
  complete_by: string | Date;
}>;

function requiredUlid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value)) {
    throw new Error(`shopify_privacy_${label}_invalid`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`shopify_privacy_${label}_invalid`);
  }
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new Error(`shopify_privacy_${label}_invalid`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error(`shopify_privacy_${label}_invalid`);
  return date.toISOString();
}

export interface ShopifyPrivacyControlPort {
  claim(): Promise<ShopifyPrivacyClaim | null>;
  dispatchRedaction(claim: ShopifyPrivacyClaim): Promise<number>;
  prepareDataRequest(claim: ShopifyPrivacyClaim): Promise<number>;
  complete(claim: ShopifyPrivacyClaim): Promise<void>;
  retry(
    claim: ShopifyPrivacyClaim,
    failure: DeletionFailureEvidence,
    delaySeconds: number,
  ): Promise<"retry_wait" | "attention_required">;
  reconcile(): Promise<Readonly<Record<string, unknown>>>;
  metrics(): Promise<Readonly<Record<string, unknown>>>;
  preflight(): Promise<void>;
}

export class ShopifyPrivacyControlStore implements ShopifyPrivacyControlPort {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly workerId: string,
  ) {
    if (!workerId.trim()) throw new Error("shopify_privacy_worker_id_invalid");
  }

  private query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) {
    return asDeletionControl(this.db, (client) => client.query<T>(text, values));
  }

  async claim(): Promise<ShopifyPrivacyClaim | null> {
    const result = await this.query<ClaimRow>(
      "select * from control_plane.claim_shopify_privacy_jobs($1::text,900,1)",
      [this.workerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.topic !== "customers/data_request" && row.topic !== "customers/redact") {
      throw new Error("shopify_privacy_topic_invalid");
    }
    if (!Array.isArray(row.case_ids) || row.case_ids.length < 1 || row.case_ids.length > 1_000) {
      throw new Error("shopify_privacy_case_ids_invalid");
    }
    return Object.freeze({
      messageId: positiveSafeInteger(row.message_id, "message_id"),
      readCount: positiveSafeInteger(row.read_count, "read_count"),
      visibilityDeadline: timestamp(row.visibility_deadline, "visibility_deadline"),
      inboxId: requiredUlid(row.inbox_id, "inbox_id"),
      topic: row.topic,
      caseIds: Object.freeze(row.case_ids.map((value) => requiredUlid(value, "case_id"))),
      completeBy: timestamp(row.complete_by, "complete_by"),
    });
  }

  async dispatchRedaction(claim: ShopifyPrivacyClaim): Promise<number> {
    const result = await this.query<{ dispatched: unknown }>(
      `select control_plane.dispatch_shopify_customer_redaction(
         $1::bigint,$2::text,$3::text,$4::integer
       ) as dispatched`,
      [claim.messageId, claim.inboxId, this.workerId, claim.readCount],
    );
    return positiveSafeInteger(result.rows[0]?.dispatched, "dispatch_count");
  }

  async prepareDataRequest(claim: ShopifyPrivacyClaim): Promise<number> {
    const result = await this.query<{ prepared: unknown }>(
      `select control_plane.prepare_shopify_customer_data_request(
         $1::bigint,$2::text,$3::text,$4::integer
       ) as prepared`,
      [claim.messageId, claim.inboxId, this.workerId, claim.readCount],
    );
    const prepared = Number(result.rows[0]?.prepared);
    if (!Number.isSafeInteger(prepared) || prepared < 0) {
      throw new Error("shopify_privacy_prepare_count_invalid");
    }
    return prepared;
  }

  async complete(claim: ShopifyPrivacyClaim): Promise<void> {
    await this.query(
      "select control_plane.complete_shopify_privacy_job($1,$2,$3,$4)",
      [claim.messageId, claim.inboxId, this.workerId, claim.readCount],
    );
  }

  async retry(
    claim: ShopifyPrivacyClaim,
    failure: DeletionFailureEvidence,
    delaySeconds: number,
  ): Promise<"retry_wait" | "attention_required"> {
    const result = await this.query<{ state: unknown }>(
      `select control_plane.retry_shopify_privacy_job(
         $1::bigint,$2::text,$3::text,$4::integer,$5::jsonb,$6::integer
       ) as state`,
      [
        claim.messageId,
        claim.inboxId,
        this.workerId,
        claim.readCount,
        JSON.stringify(failure),
        delaySeconds,
      ],
    );
    const state = result.rows[0]?.state;
    if (state !== "retry_wait" && state !== "attention_required") {
      throw new Error("shopify_privacy_retry_state_invalid");
    }
    return state;
  }

  async reconcile(): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.query<{ result: unknown }>(
      "select control_plane.reconcile_shopify_privacy_cases() as result",
    );
    const value = result.rows[0]?.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("shopify_privacy_reconciliation_invalid");
    }
    return Object.freeze(value as Readonly<Record<string, unknown>>);
  }

  async metrics(): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.query<{ result: unknown }>(
      "select control_plane.shopify_privacy_queue_metrics() as result",
    );
    const value = result.rows[0]?.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("shopify_privacy_metrics_invalid");
    }
    return Object.freeze(value as Readonly<Record<string, unknown>>);
  }

  async preflight(): Promise<void> {
    await this.query("select control_plane.assert_shopify_privacy_queue_ready()");
  }
}

export class ShopifyPrivacyProcessor {
  constructor(private readonly control: ShopifyPrivacyControlPort) {}

  async process(claim: ShopifyPrivacyClaim): Promise<ShopifyPrivacyProcessOutcome> {
    try {
      if (claim.topic === "customers/redact") {
        const dispatched = await this.control.dispatchRedaction(claim);
        if (dispatched !== claim.caseIds.length) {
          throw new Error("shopify_privacy_dispatch_cardinality_mismatch");
        }
      } else {
        const prepared = await this.control.prepareDataRequest(claim);
        if (prepared !== claim.caseIds.length) {
          throw new Error("shopify_privacy_prepare_cardinality_mismatch");
        }
      }
      await this.control.complete(claim);
      return Object.freeze({ status: "dispatched", topic: claim.topic });
    } catch (error) {
      const failure = deletionFailureEvidence(error);
      const retryDelaySeconds = Math.min(3_600, Math.max(5, 5 * 2 ** Math.min(claim.readCount, 9)));
      const state = await this.control.retry(claim, failure, retryDelaySeconds);
      return Object.freeze({
        status: state === "retry_wait" ? "retry_scheduled" : "attention_required",
        failure,
        retryDelaySeconds,
      });
    }
  }
}
