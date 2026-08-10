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
      setShowCreate(false);
      setCreateName("");
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
    <section className={styles.organizationWorkspace} aria-labelledby="organization-title" aria-busy={loading}>
      <header className={styles.organizationSettingsHero}>
        <h2 id="organization-title">Organisation</h2>
        <button
          type="button"
          className={styles.organizationSettingsButton}
          onClick={() => void load()}
          disabled={loading || Boolean(busy)}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? (
        <div className={styles.organizationSettingsAlert} data-kind="error" role="alert">
          <strong>Change not saved</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className={styles.organizationSettingsAlert} data-kind="success" role="status">
          <strong>Saved</strong>
          <span>{notice}</span>
        </div>
      ) : null}

      <div className={styles.organizationSettingsStack}>
        <section className={styles.organizationSettingsGroup} aria-label="Workspaces">
          <h3 className={styles.organizationSettingsGroupLabel}>Workspaces</h3>
          <div className={styles.organizationSettingsCard}>
            {sortedOrganisations.map((organisation) => (
              <div className={styles.organizationSettingsRow} key={organisation.tenantId}>
                <div className={styles.organizationSettingsRowCopy}>
                  <strong>{organisation.name}</strong>
                  <p>{formatRole(organisation.role)} · {organisation.timezone}</p>
                </div>
                <div className={styles.organizationSettingsRowControl}>
                  {organisation.selected ? (
                    <span className={styles.organizationSettingsValue}>Active</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.organizationSettingsButton}
                      disabled={Boolean(busy) || organisation.status !== "active"}
                      onClick={() => void mutate("select", async () => {
                        await jsonRequest("/api/organisations/select", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ tenantId: organisation.tenantId }),
                        });
                        onOrganisationChanged?.();
                      })}
                    >
                      {organisation.status === "active" ? "Switch" : formatStatus(organisation.status)}
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div className={styles.organizationSettingsRow}>
              <div className={styles.organizationSettingsRowCopy}>
                <strong>New organisation</strong>
                <p>Create another workspace for a separate business.</p>
              </div>
              <div className={styles.organizationSettingsRowControl}>
                <button
                  type="button"
                  className={styles.organizationSettingsButton}
                  aria-expanded={showCreate}
                  onClick={() => setShowCreate((value) => !value)}
                >
                  {showCreate ? "Cancel" : "New"}
                </button>
              </div>
            </div>
            {showCreate ? (
              <form className={styles.organizationSettingsFormRow} onSubmit={create}>
                <label>
                  <span>Name</span>
                  <input
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    required
                    maxLength={120}
                  />
                </label>
                <label>
                  <span>Timezone</span>
                  <input
                    value={createTimezone}
                    onChange={(event) => setCreateTimezone(event.target.value)}
                    required
                    maxLength={100}
                  />
                </label>
                <button
                  type="submit"
                  className={styles.organizationSettingsButton}
                  disabled={busy === "create"}
                >
                  {busy === "create" ? "Creating…" : "Create"}
                </button>
              </form>
            ) : null}
          </div>
        </section>

        <section className={styles.organizationSettingsGroup} aria-label="Profile">
          <h3 className={styles.organizationSettingsGroupLabel}>Profile</h3>
          <div className={styles.organizationSettingsCard}>
            <form className={styles.organizationSettingsRow} onSubmit={rename}>
              <div className={styles.organizationSettingsRowCopy}>
                <strong>Display name</strong>
                <p>Shown across Albert for this workspace.</p>
              </div>
              <div className={styles.organizationSettingsRowControl}>
                <input
                  className={styles.organizationSettingsInlineInput}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  disabled={!isOwner}
                  maxLength={120}
                  aria-label="Display name"
                />
                {isOwner ? (
                  <button
                    type="submit"
                    className={styles.organizationSettingsButton}
                    disabled={busy === "rename" || !renameValue.trim()}
                  >
                    {busy === "rename" ? "Saving…" : "Save"}
                  </button>
                ) : null}
              </div>
            </form>
            <div className={styles.organizationSettingsRow}>
              <div className={styles.organizationSettingsRowCopy}>
                <strong>Timezone</strong>
                <p>Used for reporting periods and schedules.</p>
              </div>
              <div className={styles.organizationSettingsRowControl}>
                <span className={styles.organizationSettingsValue}>
                  {workspace?.settings.tenant.timezone || "—"}
                </span>
              </div>
            </div>
            <div className={styles.organizationSettingsRow}>
              <div className={styles.organizationSettingsRowCopy}>
                <strong>Your role</strong>
                <p>Access level in the active organisation.</p>
              </div>
              <div className={styles.organizationSettingsRowControl}>
                <span className={styles.organizationSettingsValue}>
                  {workspace ? formatRole(workspace.settings.tenant.role) : "Loading"}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.organizationSettingsGroup} aria-label="Members">
          <h3 className={styles.organizationSettingsGroupLabel}>Members</h3>
          <div className={styles.organizationSettingsCard}>
            {(workspace?.settings.members ?? []).map((member) => (
              <div className={styles.organizationSettingsRow} key={member.userId}>
                <div className={styles.organizationSettingsRowCopy}>
                  <strong>
                    {member.email || "Albert member"}
                    {member.isCurrentUser ? " · You" : ""}
                  </strong>
                  <p>{formatStatus(member.status)}</p>
                </div>
                <div className={styles.organizationSettingsRowControl}>
                  {isOwner ? (
                    <select
                      className={styles.organizationSettingsSelect}
                      aria-label={`Role for ${member.email || "member"}`}
                      value={member.role}
                      disabled={busy === `member-${member.userId}`}
                      onChange={(event) => updateMember(member, event.target.value as OrganisationRole, "active")}
                    >
                      {roles.map((role) => (
                        <option value={role} key={role}>{formatRole(role)}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={styles.organizationSettingsValue}>{formatRole(member.role)}</span>
                  )}
                  {isOwner && !member.isCurrentUser ? (
                    <button
                      type="button"
                      className={styles.organizationSettingsButton}
                      onClick={() => updateMember(member, member.role, "revoked")}
                      disabled={busy === `member-${member.userId}`}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {isOwner ? (
              <form className={styles.organizationSettingsFormRow} onSubmit={addMember}>
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    value={memberEmail}
                    onChange={(event) => setMemberEmail(event.target.value)}
                    placeholder="name@business.com"
                    required
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select
                    className={styles.organizationSettingsSelect}
                    value={memberRole}
                    onChange={(event) => setMemberRole(event.target.value as OrganisationRole)}
                  >
                    {roles.map((role) => (
                      <option value={role} key={role}>{formatRole(role)}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className={styles.organizationSettingsButton}
                  disabled={busy === "member-add"}
                >
                  {busy === "member-add" ? "Adding…" : "Add"}
                </button>
              </form>
            ) : null}
          </div>
        </section>

        {isOwner ? (
          <section className={styles.organizationSettingsGroup} aria-label="Danger zone">
            <h3 className={styles.organizationSettingsGroupLabel}>Delete organisation</h3>
            <div className={`${styles.organizationSettingsCard} ${styles.organizationSettingsDangerCard}`}>
              {!deletion ? (
                <form className={styles.organizationSettingsDangerBody} onSubmit={requestDeletion}>
                  <div className={styles.organizationSettingsRowCopy}>
                    <strong>Verified deletion</strong>
                    <p>
                      Fences connections and starts a verified purge. Enter{" "}
                      <code>DELETE {workspace?.settings.tenant.name}</code>.
                    </p>
                  </div>
                  <div className={styles.organizationSettingsDangerActions}>
                    <input
                      className={styles.organizationSettingsInlineInput}
                      value={deleteConfirmation}
                      onChange={(event) => setDeleteConfirmation(event.target.value)}
                      aria-label="Deletion confirmation"
                    />
                    <button
                      type="submit"
                      className={styles.organizationSettingsDangerButton}
                      disabled={busy === "delete-request"}
                    >
                      Request deletion
                    </button>
                  </div>
                </form>
              ) : awaitingDeletionApproval ? (
                <form className={styles.organizationSettingsDangerBody} onSubmit={approveDeletion}>
                  <div className={styles.organizationSettingsRowCopy}>
                    <strong>Final approval</strong>
                    <p>
                      Reversible until approved. Enter{" "}
                      <code>ERASE {workspace?.settings.tenant.name}</code> within 30 minutes.
                    </p>
                  </div>
                  <div className={styles.organizationSettingsDangerActions}>
                    <input
                      className={styles.organizationSettingsInlineInput}
                      value={eraseConfirmation}
                      onChange={(event) => setEraseConfirmation(event.target.value)}
                      aria-label="Final erasure confirmation"
                    />
                    <button
                      type="button"
                      className={styles.organizationSettingsButton}
                      onClick={cancelDeletion}
                      disabled={busy === "delete-cancel"}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className={styles.organizationSettingsDangerButton}
                      disabled={busy === "delete-approve"}
                    >
                      Approve erasure
                    </button>
                  </div>
                </form>
              ) : (
                <div className={styles.organizationSettingsDangerBody}>
                  <div className={styles.organizationSettingsRowCopy}>
                    <strong>Deletion {formatStatus(deletion.status)}</strong>
                    <p>New writes are fenced while credentials and data stores are removed.</p>
                  </div>
                  <span className={styles.organizationSettingsValue}>
                    {formatStatus(deletion.status)}
                  </span>
                </div>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}
