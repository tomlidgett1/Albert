"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "../dash.module.css";

type DeletionProof = Readonly<{
  proofId: string;
  proofDigest: string;
  completedAt: string;
  remoteRevocation: Readonly<Record<string, unknown>>;
  storeVerification: Readonly<Record<string, unknown>>;
  serviceVersion: string;
}>;

export type TenantDeletionReceipt = Readonly<{
  deletionRequestId: string;
  status: "awaiting_approval" | "queued" | "running" | "retry_wait" | "verifying" | "failed" | "completed" | "cancelled";
  requestedAt: string;
  approvedAt: string | null;
  purgeDueAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  proof: DeletionProof | null;
}>;

const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const digest = /^[a-f0-9]{64}$/u;
const statuses = new Set<TenantDeletionReceipt["status"]>([
  "awaiting_approval", "queued", "running", "retry_wait", "verifying",
  "failed", "completed", "cancelled",
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseTenantDeletionReceipt(value: unknown): TenantDeletionReceipt | null {
  if (!record(value) || typeof value.deletionRequestId !== "string" || !ulid.test(value.deletionRequestId)) return null;
  if (typeof value.status !== "string" || !statuses.has(value.status as TenantDeletionReceipt["status"])) return null;
  if (typeof value.requestedAt !== "string") return null;
  const nullableString = (candidate: unknown) => candidate === null || typeof candidate === "string";
  if (![value.approvedAt, value.purgeDueAt, value.completedAt, value.lastErrorCode].every(nullableString)) return null;
  let proof: DeletionProof | null = null;
  if (value.proof !== null) {
    if (!record(value.proof)
      || typeof value.proof.proofId !== "string" || !ulid.test(value.proof.proofId)
      || typeof value.proof.proofDigest !== "string" || !digest.test(value.proof.proofDigest)
      || typeof value.proof.completedAt !== "string"
      || !record(value.proof.remoteRevocation)
      || !record(value.proof.storeVerification)
      || typeof value.proof.serviceVersion !== "string") return null;
    proof = {
      proofId: value.proof.proofId,
      proofDigest: value.proof.proofDigest,
      completedAt: value.proof.completedAt,
      remoteRevocation: value.proof.remoteRevocation,
      storeVerification: value.proof.storeVerification,
      serviceVersion: value.proof.serviceVersion,
    };
  }
  if (value.status === "completed" && !proof) return null;
  return {
    deletionRequestId: value.deletionRequestId,
    status: value.status as TenantDeletionReceipt["status"],
    requestedAt: value.requestedAt,
    approvedAt: value.approvedAt as string | null,
    purgeDueAt: value.purgeDueAt as string | null,
    completedAt: value.completedAt as string | null,
    lastErrorCode: value.lastErrorCode as string | null,
    proof,
  };
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase());
}

function time(value: string | null): string {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Recorded";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

type StageState = "complete" | "active" | "pending";

function stages(receipt: TenantDeletionReceipt): readonly Readonly<{
  label: string;
  detail: string;
  state: StageState;
}>[] {
  const running = receipt.status === "running" || receipt.status === "retry_wait" || receipt.status === "failed";
  const verifying = receipt.status === "verifying";
  const completed = receipt.status === "completed";
  return [
    {
      label: "Deletion approved",
      detail: receipt.approvedAt ? time(receipt.approvedAt) : "Waiting for final approval",
      state: receipt.approvedAt ? "complete" : "active",
    },
    {
      label: "Credentials destroyed and writes fenced",
      detail: "Provider credentials and new data writes are blocked before purge.",
      state: completed || verifying ? "complete" : running ? "active" : "pending",
    },
    {
      label: "All data stores purged",
      detail: "Raw objects, analytical rows, control records, artefacts, queues, and caches.",
      state: completed || verifying ? "complete" : running ? "active" : "pending",
    },
    {
      label: "Independent residual checks",
      detail: "Every governed store must report zero scoped residuals.",
      state: completed ? "complete" : verifying ? "active" : "pending",
    },
    {
      label: "Completion proof committed",
      detail: receipt.proof ? `Proof ${receipt.proof.proofId}` : "A hash-only proof is committed after verification.",
      state: receipt.proof ? "complete" : "pending",
    },
  ];
}

export default function TenantDeletionWorkspace({
  initialReceipt,
}: Readonly<{ initialReceipt: TenantDeletionReceipt }>) {
  const [receipt, setReceipt] = useState(initialReceipt);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [organisationName, setOrganisationName] = useState("");
  const [timezone, setTimezone] = useState("Australia/Melbourne");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch(
        `/api/tenant/deletion?requestId=${encodeURIComponent(receipt.deletionRequestId)}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null) as { deletion?: unknown; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "Deletion status could not be refreshed.");
      const next = parseTenantDeletionReceipt(payload?.deletion);
      if (!next) throw new Error("Deletion status returned invalid state.");
      setReceipt(next);
      setError("");
    } catch (refreshError) {
      if (!quiet) setError(refreshError instanceof Error ? refreshError.message : "Deletion status is unavailable.");
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, [receipt.deletionRequestId]);

  useEffect(() => {
    if (receipt.status === "completed" || receipt.status === "cancelled") return;
    const timer = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(timer);
  }, [receipt.status, refresh]);

  const stageRows = useMemo(() => stages(receipt), [receipt]);

  const downloadProof = () => {
    if (!receipt.proof) return;
    const blob = new Blob([`${JSON.stringify({
      schemaVersion: 1,
      kind: "albert.tenant-deletion-receipt",
      ...receipt,
    }, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `albert-deletion-${receipt.deletionRequestId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const createOrganisation = (event: FormEvent) => {
    event.preventDefault();
    if (!organisationName.trim() || creating) return;
    setCreating(true);
    setError("");
    void fetch("/api/organisations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: organisationName.trim(), timezone }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "The new organisation could not be created.");
      window.location.reload();
    }).catch((createError) => {
      setError(createError instanceof Error ? createError.message : "The new organisation could not be created.");
      setCreating(false);
    });
  };

  return (
    <section className={styles.deletionReceiptWorkspace} aria-labelledby="deletion-receipt-title">
      <header className={styles.organizationHero}>
        <div>
          <span>DATA LIFECYCLE</span>
          <h2 id="deletion-receipt-title">Secure deletion</h2>
          <p>This receipt remains available to you while the organisation itself is inaccessible and being removed.</p>
        </div>
        <button className={styles.organizationRefresh} type="button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh status"}
        </button>
      </header>

      {error ? <div className={styles.organizationAlert} data-kind="error" role="alert"><strong>Status unavailable</strong><span>{error}</span></div> : null}

      <div className={styles.deletionReceiptGrid} aria-live="polite">
        <article className={styles.organizationPanel}>
          <div className={styles.organizationSectionHeading}>
            <div><span>REQUEST</span><h3>Verified lifecycle</h3></div>
            <span className={styles.organizationDeletionStatus}>{label(receipt.status)}</span>
          </div>
          <ol className={styles.deletionReceiptStages}>
            {stageRows.map((stage) => (
              <li key={stage.label} data-state={stage.state}>
                <span aria-hidden="true" />
                <div><strong>{stage.label}</strong><p>{stage.detail}</p></div>
                <small>{stage.state === "complete" ? "Complete" : stage.state === "active" ? "In progress" : "Pending"}</small>
              </li>
            ))}
          </ol>
          {receipt.lastErrorCode ? (
            <div className={styles.organizationAlert} data-kind="error" role="status">
              <strong>Retrying safely</strong><span>{label(receipt.lastErrorCode)}. The durable job remains fenced and observable.</span>
            </div>
          ) : null}
        </article>

        <aside className={styles.organizationPanel}>
          <div className={styles.organizationSectionHeading}>
            <div><span>RECEIPT</span><h3>{receipt.proof ? "Completion proof" : "Request details"}</h3></div>
          </div>
          <dl className={styles.deletionReceiptDetails}>
            <div><dt>Request</dt><dd>{receipt.deletionRequestId}</dd></div>
            <div><dt>Approved</dt><dd>{time(receipt.approvedAt)}</dd></div>
            <div><dt>Completed</dt><dd>{time(receipt.completedAt)}</dd></div>
            {receipt.proof ? <>
              <div><dt>Proof</dt><dd>{receipt.proof.proofId}</dd></div>
              <div><dt>Digest</dt><dd>{receipt.proof.proofDigest}</dd></div>
              <div><dt>Release</dt><dd>{receipt.proof.serviceVersion}</dd></div>
            </> : null}
          </dl>
          {receipt.proof ? (
            <button className={styles.deletionReceiptDownload} type="button" onClick={downloadProof}>Download proof</button>
          ) : (
            <p className={styles.deletionReceiptNote}>No tenant identifier, organisation name, source record, or customer payload is retained in this receipt.</p>
          )}

          {receipt.status === "completed" ? (
            <div className={styles.deletionReceiptCreate}>
              <button type="button" onClick={() => setShowCreate((current) => !current)} aria-expanded={showCreate}>
                Start a new organisation
              </button>
              {showCreate ? (
                <form className={styles.organizationCreateForm} onSubmit={createOrganisation}>
                  <label>Name<input value={organisationName} onChange={(event) => setOrganisationName(event.target.value)} required maxLength={120} /></label>
                  <label>Timezone<input value={timezone} onChange={(event) => setTimezone(event.target.value)} required maxLength={100} /></label>
                  <div><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" disabled={creating}>{creating ? "Creating…" : "Create"}</button></div>
                </form>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
