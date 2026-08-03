"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "../dash.module.css";

type OrganisationRole = "owner" | "manager" | "bookkeeper";
type Organisation = Readonly<{
  tenantId: string;
  name: string;
  slug: string;
  role: OrganisationRole;
  status: string;
  timezone: string;
  selected: boolean;
}>;
type Member = Readonly<{
  userId: string;
  email: string | null;
  role: OrganisationRole;
  status: string;
  createdAt: string;
  isCurrentUser: boolean;
}>;
type Deletion = Readonly<{
  deletionRequestId: string;
  status: string;
  requestedAt?: string | null;
  approvalExpiresAt?: string | null;
  completedAt?: string | null;
  proofId?: string | null;
}>;
type Settings = Readonly<{
  tenant: Omit<Organisation, "selected">;
  members: readonly Member[];
  deletion: Deletion | null;
}>;
type WorkspacePayload = Readonly<{ organisations: readonly Organisation[]; settings: Settings }>;

const roles: readonly OrganisationRole[] = ["owner", "manager", "bookkeeper"];

function formatRole(role: OrganisationRole) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

function deletionFrom(value: unknown): Deletion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = row.deletionRequestId ?? row.deletion_request_id;
  if (typeof id !== "string" || typeof row.status !== "string") return null;
  return {
    deletionRequestId: id,
    status: row.status,
    approvalExpiresAt: typeof (row.approvalExpiresAt ?? row.approval_expires_at) === "string"
      ? String(row.approvalExpiresAt ?? row.approval_expires_at)
      : null,
  };
}

async function jsonRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(payload?.error || "The organisation request could not be completed.");
  if (!payload) throw new Error("The organisation service returned an empty response.");
  return payload;
}

export default function OrganizationWorkspace({
  onOrganisationChanged,
  onOrganisationRenamed,
}: Readonly<{
  onOrganisationChanged?: () => void;
  onOrganisationRenamed?: (name: string) => void;
}>) {
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createTimezone, setCreateTimezone] = useState("Australia/Melbourne");
  const [renameValue, setRenameValue] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<OrganisationRole>("manager");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [eraseConfirmation, setEraseConfirmation] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await jsonRequest<WorkspacePayload>("/api/organisations");
      setWorkspace(payload);
      setRenameValue(payload.settings.tenant.name);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Organisation settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const mutate = useCallback(async (key: string, action: () => Promise<void>, success?: string) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "The change could not be saved.");
    } finally {
      setBusy("");
    }
  }, []);

  const isOwner = workspace?.settings.tenant.role === "owner";
  const deletion = workspace?.settings.deletion ?? null;
  const awaitingDeletionApproval = deletion?.status === "awaiting_approval";
  const sortedOrganisations = useMemo(
    () => [...(workspace?.organisations ?? [])].sort((left, right) => Number(right.selected) - Number(left.selected)),
    [workspace],
  );

  const create = (event: FormEvent) => {
    event.preventDefault();
    void mutate("create", async () => {
      await jsonRequest("/api/organisations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: createName, timezone: createTimezone }),
      });
      onOrganisationChanged?.();
    });
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    void mutate("rename", async () => {
      await jsonRequest("/api/organisations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: workspace?.settings.tenant.tenantId,
          displayName: renameValue,
        }),
      });
      setWorkspace((current) => current ? {
        ...current,
        organisations: current.organisations.map((organisation) => organisation.selected
          ? { ...organisation, name: renameValue.trim() }
          : organisation),
        settings: { ...current.settings, tenant: { ...current.settings.tenant, name: renameValue.trim() } },
      } : current);
      onOrganisationRenamed?.(renameValue.trim());
    }, "Organisation name updated.");
  };

  const addMember = (event: FormEvent) => {
    event.preventDefault();
    void mutate("member-add", async () => {
      await jsonRequest("/api/organisations/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: workspace?.settings.tenant.tenantId,
          email: memberEmail,
          role: memberRole,
        }),
      });
      setMemberEmail("");
      await load();
    }, "Member access is active.");
  };

  const updateMember = (member: Member, role: OrganisationRole, status: "active" | "revoked") => {
    void mutate(`member-${member.userId}`, async () => {
      await jsonRequest("/api/organisations/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: workspace?.settings.tenant.tenantId,
          userId: member.userId,
          role,
          status,
        }),
      });
      await load();
    }, status === "revoked" ? "Member access revoked." : "Member role updated.");
  };

  const requestDeletion = (event: FormEvent) => {
    event.preventDefault();
    void mutate("delete-request", async () => {
      const result = await jsonRequest<{ deletion?: unknown }>("/api/tenant/deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: workspace?.settings.tenant.tenantId,
          confirmation: deleteConfirmation,
        }),
      });
      const next = deletionFrom(result.deletion);
      if (!next) throw new Error("The deletion request returned invalid state.");
      setWorkspace((current) => current ? {
        ...current,
        settings: { ...current.settings, deletion: next },
      } : current);
      setDeleteConfirmation("");
    }, "First confirmation recorded. Complete the final approval within 30 minutes.");
  };

  const approveDeletion = (event: FormEvent) => {
    event.preventDefault();
    if (!deletion) return;
    void mutate("delete-approve", async () => {
      await jsonRequest("/api/tenant/deletion/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: workspace?.settings.tenant.tenantId,
          requestId: deletion.deletionRequestId,
          confirmation: eraseConfirmation,
        }),
      });
      setWorkspace((current) => current ? {
        ...current,
        settings: { ...current.settings, deletion: { ...deletion, status: "queued" } },
      } : current);
      setEraseConfirmation("");
      onOrganisationChanged?.();
    }, "Deletion is queued. Albert has fenced new writes and started the audited purge.");
  };

  const cancelDeletion = () => {
    if (!deletion) return;
    void mutate("delete-cancel", async () => {
      await jsonRequest("/api/tenant/deletion/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: workspace?.settings.tenant.tenantId,
          requestId: deletion.deletionRequestId,
        }),
      });
      setWorkspace((current) => current ? {
        ...current,
        settings: { ...current.settings, deletion: null },
      } : current);
    }, "Deletion request cancelled.");
  };

  return (
    <section className={styles.organizationWorkspace} aria-labelledby="organization-title">
      <header className={styles.organizationHero}>
        <div>
          <span>ORGANISATION</span>
          <h2 id="organization-title">{workspace?.settings.tenant.name || "Organisation settings"}</h2>
          <p>Manage the active workspace, member roles, and the verified deletion lifecycle.</p>
        </div>
        <button type="button" className={styles.organizationRefresh} onClick={() => void load()} disabled={loading || Boolean(busy)}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? <div className={styles.organizationAlert} data-kind="error" role="alert"><strong>Change not saved</strong><span>{error}</span></div> : null}
      {notice ? <div className={styles.organizationAlert} data-kind="success" role="status"><strong>Saved</strong><span>{notice}</span></div> : null}

      <div className={styles.organizationLayout} aria-busy={loading}>
        <aside className={styles.organizationRail} aria-label="Your organisations">
          <div className={styles.organizationSectionHeading}>
            <div><span>WORKSPACES</span><h3>Your organisations</h3></div>
            <button type="button" onClick={() => setShowCreate((value) => !value)} aria-expanded={showCreate}>+ New</button>
          </div>
          {showCreate ? (
            <form className={styles.organizationCreateForm} onSubmit={create}>
              <label>Name<input value={createName} onChange={(event) => setCreateName(event.target.value)} required maxLength={120} /></label>
              <label>Timezone<input value={createTimezone} onChange={(event) => setCreateTimezone(event.target.value)} required maxLength={100} /></label>
              <div><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" disabled={busy === "create"}>{busy === "create" ? "Creating…" : "Create"}</button></div>
            </form>
          ) : null}
          <div className={styles.organizationList}>
            {sortedOrganisations.map((organisation) => (
              <button
                type="button"
                key={organisation.tenantId}
                data-selected={organisation.selected}
                disabled={organisation.selected || Boolean(busy) || organisation.status !== "active"}
                onClick={() => void mutate("select", async () => {
                  await jsonRequest("/api/organisations/select", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tenantId: organisation.tenantId }),
                  });
                  onOrganisationChanged?.();
                })}
              >
                <span>{organisation.name.charAt(0).toUpperCase()}</span>
                <span><strong>{organisation.name}</strong><small>{formatRole(organisation.role)} · {organisation.timezone}</small></span>
                <i>{organisation.selected ? "Active" : organisation.status === "active" ? "Switch" : formatStatus(organisation.status)}</i>
              </button>
            ))}
          </div>
        </aside>

        <div className={styles.organizationMain}>
          <section className={styles.organizationPanel}>
            <div className={styles.organizationSectionHeading}>
              <div><span>PROFILE</span><h3>Organisation details</h3></div>
              <span className={styles.organizationRoleBadge}>{workspace ? formatRole(workspace.settings.tenant.role) : "Loading"}</span>
            </div>
            <form className={styles.organizationInlineForm} onSubmit={rename}>
              <label>Display name<input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} disabled={!isOwner} maxLength={120} /></label>
              <label>Timezone<input value={workspace?.settings.tenant.timezone ?? ""} disabled /></label>
              {isOwner ? <button type="submit" disabled={busy === "rename" || !renameValue.trim()}>{busy === "rename" ? "Saving…" : "Save"}</button> : null}
            </form>
          </section>

          <section className={styles.organizationPanel}>
            <div className={styles.organizationSectionHeading}>
              <div><span>ACCESS</span><h3>Members</h3></div>
              <span className={styles.organizationCount}>{workspace?.settings.members.length ?? 0}</span>
            </div>
            {isOwner ? (
              <form className={styles.organizationMemberForm} onSubmit={addMember}>
                <label>Email<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="name@business.com" required /></label>
                <label>Role<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as OrganisationRole)}>{roles.map((role) => <option value={role} key={role}>{formatRole(role)}</option>)}</select></label>
                <button type="submit" disabled={busy === "member-add"}>{busy === "member-add" ? "Adding…" : "Add member"}</button>
              </form>
            ) : null}
            <div className={styles.organizationMembers} role="list">
              {(workspace?.settings.members ?? []).map((member) => (
                <article key={member.userId} role="listitem">
                  <span className={styles.organizationMemberAvatar}>{(member.email || "A").charAt(0).toUpperCase()}</span>
                  <div><strong>{member.email || "Albert member"}{member.isCurrentUser ? " · You" : ""}</strong><small>{formatStatus(member.status)}</small></div>
                  {isOwner ? (
                    <select
                      aria-label={`Role for ${member.email || "member"}`}
                      value={member.role}
                      disabled={busy === `member-${member.userId}`}
                      onChange={(event) => updateMember(member, event.target.value as OrganisationRole, "active")}
                    >{roles.map((role) => <option value={role} key={role}>{formatRole(role)}</option>)}</select>
                  ) : <span>{formatRole(member.role)}</span>}
                  {isOwner && !member.isCurrentUser ? <button type="button" onClick={() => updateMember(member, member.role, "revoked")} disabled={busy === `member-${member.userId}`}>Revoke</button> : null}
                </article>
              ))}
            </div>
          </section>

          {isOwner ? (
            <section className={`${styles.organizationPanel} ${styles.organizationDangerPanel}`}>
              <div className={styles.organizationSectionHeading}>
                <div><span>DATA LIFECYCLE</span><h3>Delete organisation</h3></div>
                {deletion ? <span className={styles.organizationDeletionStatus}>{formatStatus(deletion.status)}</span> : null}
              </div>
              {!deletion ? (
                <form className={styles.organizationDeletionForm} onSubmit={requestDeletion}>
                  <p>This fences every connection, destroys credentials, and starts a verified cross-store purge. Enter <code>DELETE {workspace?.settings.tenant.name}</code>.</p>
                  <div><input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} aria-label="Deletion confirmation" /><button type="submit" disabled={busy === "delete-request"}>Request deletion</button></div>
                </form>
              ) : awaitingDeletionApproval ? (
                <form className={styles.organizationDeletionForm} onSubmit={approveDeletion}>
                  <p>The request is reversible until final approval. Enter <code>ERASE {workspace?.settings.tenant.name}</code> within 30 minutes.</p>
                  <div><input value={eraseConfirmation} onChange={(event) => setEraseConfirmation(event.target.value)} aria-label="Final erasure confirmation" /><button type="button" onClick={cancelDeletion} disabled={busy === "delete-cancel"}>Cancel</button><button type="submit" disabled={busy === "delete-approve"}>Approve erasure</button></div>
                </form>
              ) : (
                <div className={styles.organizationDeletionProgress}>
                  <span aria-hidden="true" />
                  <p><strong>Verified deletion is {formatStatus(deletion.status)}.</strong> New writes are fenced while credentials, raw objects, analytical rows, semantic artefacts, and caches are removed and counted.</p>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}
