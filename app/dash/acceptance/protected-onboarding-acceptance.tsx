"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  getServerThemePreference,
  getThemePreference,
  subscribeToThemePreference,
} from "@/app/theme-preference";
import { createClient } from "@/utils/supabase/client";
import styles from "../dash.module.css";

type Phase = "claim" | "needs_relogin" | "awaiting_login" | "ready_receipt" | "completed";
type StoredJourney = Readonly<{
  journeyId: string;
  phase: Exclude<Phase, "claim">;
  claimDigest?: string;
  receiptDigest?: string;
  browserNonce?: string;
}>;

const DIGEST = /^[a-f0-9]{64}$/u;

function storageKey(journeyId: string): string {
  return `albert-protected-onboarding:${journeyId}`;
}

function readStoredJourney(journeyId: string): StoredJourney | null {
  try {
    const candidate = JSON.parse(sessionStorage.getItem(storageKey(journeyId)) ?? "null") as
      Partial<StoredJourney> | null;
    if (!candidate || candidate.journeyId !== journeyId ||
        !["needs_relogin", "awaiting_login", "ready_receipt", "completed"].includes(
          candidate.phase ?? "",
        ) || (candidate.claimDigest !== undefined && !DIGEST.test(candidate.claimDigest)) ||
        (candidate.receiptDigest !== undefined && !DIGEST.test(candidate.receiptDigest)) ||
        (candidate.phase !== "completed" &&
          !/^[A-Za-z0-9_-]{43}$/u.test(candidate.browserNonce ?? ""))) {
      return null;
    }
    return candidate as StoredJourney;
  } catch {
    return null;
  }
}

function writeStoredJourney(journey: StoredJourney) {
  sessionStorage.setItem(storageKey(journey.journeyId), JSON.stringify(journey));
}

function browserNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function stageState(index: number, active: number): "complete" | "active" | "pending" {
  if (index < active) return "complete";
  if (index === active) return "active";
  return "pending";
}

export default function ProtectedOnboardingAcceptance({
  journeyId,
}: Readonly<{ journeyId: string | null }>) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const theme = useSyncExternalStore(
    subscribeToThemePreference,
    getThemePreference,
    getServerThemePreference,
  );
  const [phase, setPhase] = useState<Phase>("claim");
  const [code, setCode] = useState("");
  const [claimDigest, setClaimDigest] = useState<string | null>(null);
  const [receiptDigest, setReceiptDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!journeyId) return;
    const stored = readStoredJourney(journeyId);
    if (!stored) return;
    let cancelled = false;
    const restoreTimer = window.setTimeout(() => {
      if (cancelled) return;
      setPhase(stored.phase);
      setClaimDigest(stored.claimDigest ?? null);
      setReceiptDigest(stored.receiptDigest ?? null);
      if (stored.phase === "awaiting_login") {
        void supabase.auth.getSession().then(({ data }) => {
          if (cancelled || !data.session) return;
          setPhase("ready_receipt");
          writeStoredJourney({ ...stored, phase: "ready_receipt" });
        });
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(restoreTimer);
    };
  }, [journeyId, supabase]);

  async function claim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!journeyId || !/^[A-Za-z0-9_-]{43}$/u.test(code)) {
      setError("Enter the complete one-use code from the recipient-decrypted operator file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const continuityNonce = browserNonce();
      const response = await fetch("/api/acceptance/onboarding/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ journeyId, code, browserNonce: continuityNonce }),
      });
      const payload = await response.json().catch(() => null) as
        Readonly<{ claim?: Readonly<{ claimDigest?: unknown }>; error?: unknown }> | null;
      if (!response.ok || typeof payload?.claim?.claimDigest !== "string" ||
          !DIGEST.test(payload.claim.claimDigest)) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "The journey could not be claimed.");
      }
      const digest = payload.claim.claimDigest;
      setCode("");
      setClaimDigest(digest);
      setPhase("needs_relogin");
      writeStoredJourney({
        journeyId,
        phase: "needs_relogin",
        claimDigest: digest,
        browserNonce: continuityNonce,
      });
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "The journey could not be claimed.");
    } finally {
      setBusy(false);
    }
  }

  async function beginRelogin() {
    if (!journeyId || !claimDigest) return;
    const stored = readStoredJourney(journeyId);
    if (!stored?.browserNonce) {
      setError("This tab no longer holds the one-use browser continuity nonce.");
      return;
    }
    setBusy(true);
    setError("");
    writeStoredJourney({ ...stored, phase: "awaiting_login", claimDigest });
    const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
    if (signOutError) {
      writeStoredJourney({ ...stored, phase: "needs_relogin", claimDigest });
      setError("Albert could not end this browser session. Try again.");
      setBusy(false);
      return;
    }
    const next = `/dash/acceptance?journey=${journeyId}`;
    router.push(`/login?next=${encodeURIComponent(next)}`);
  }

  async function completeReceipt() {
    if (!journeyId || !claimDigest) return;
    const stored = readStoredJourney(journeyId);
    if (!stored?.browserNonce) {
      setError("This tab no longer holds the one-use browser continuity nonce.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/acceptance/onboarding/receipt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ journeyId, browserNonce: stored.browserNonce }),
      });
      const payload = await response.json().catch(() => null) as
        Readonly<{ receipt?: Readonly<{ receiptDigest?: unknown }>; error?: unknown }> | null;
      if (!response.ok || typeof payload?.receipt?.receiptDigest !== "string" ||
          !DIGEST.test(payload.receipt.receiptDigest)) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "The browser receipt could not be sealed.");
      }
      const digest = payload.receipt.receiptDigest;
      setReceiptDigest(digest);
      setPhase("completed");
      writeStoredJourney({ journeyId, phase: "completed", claimDigest, receiptDigest: digest });
    } catch (receiptError) {
      setError(receiptError instanceof Error ? receiptError.message : "The browser receipt could not be sealed.");
    } finally {
      setBusy(false);
    }
  }

  const activeStage = phase === "claim" ? 0
    : phase === "needs_relogin" || phase === "awaiting_login" ? 1
      : phase === "ready_receipt" ? 2
        : 3;

  return (
    <main className={styles.dash} data-theme={theme}>
      <section className={styles.organizationWorkspace}>
        <header className={styles.organizationHero}>
          <div>
            <span>PROTECTED RELEASE ACCEPTANCE</span>
            <h2>Complete a live onboarding journey</h2>
            <p>
              This one-use production journey binds a fresh confirmed owner, a fresh organisation,
              a post-claim login, this browser, and the three live OAuth connections to one candidate.
            </p>
          </div>
          <a className={styles.organizationRefresh} href="/dash">Return to Albert</a>
        </header>

        {error ? (
          <div className={styles.organizationAlert} data-kind="error" role="alert">
            <strong>Acceptance stopped</strong><span>{error}</span>
          </div>
        ) : null}
        {phase === "completed" ? (
          <div className={styles.organizationAlert} data-kind="success" role="status">
            <strong>Browser receipt sealed</strong>
            <span>The remaining evidence now comes from the live Connections and analytics flows.</span>
          </div>
        ) : null}

        <div className={styles.organizationLayout}>
          <aside className={styles.organizationRail}>
            <div className={styles.organizationSectionHeading}>
              <div><span>SEQUENCE</span><h3>Browser continuity</h3></div>
            </div>
            <ol className={styles.deletionReceiptStages}>
              {["Claim one-use journey", "Re-login after claim", "Seal browser receipt", "Connect live sources"].map((label, index) => (
                <li key={label} data-state={stageState(index, activeStage)}>
                  <span aria-hidden="true" /><div><strong>{label}</strong></div>
                </li>
              ))}
            </ol>
          </aside>

          <div className={styles.organizationMain}>
            <section className={styles.organizationPanel}>
              <div className={styles.organizationSectionHeading}>
                <div><span>JOURNEY</span><h3>{journeyId ? "Candidate-bound check" : "Invalid link"}</h3></div>
                {journeyId ? <span className={styles.organizationRoleBadge}>one use</span> : null}
              </div>
              {!journeyId ? (
                <div className={styles.organizationDeletionForm}>
                  <p>Open the exact URL from the locally decrypted operator file. Journey identifiers are never guessed or accepted from another format.</p>
                </div>
              ) : phase === "claim" ? (
                <form className={styles.organizationDeletionForm} onSubmit={claim}>
                  <p>
                    Paste the separate 43-character code from the locally decrypted operator file.
                    The CI artifact contains only recipient-encrypted ciphertext. The code is sent only in this encrypted,
                    same-origin request and is never put in a URL, browser storage, audit, or release artifact.
                  </p>
                  <div>
                    <input
                      aria-label="One-use acceptance code"
                      autoComplete="off"
                      spellCheck={false}
                      value={code}
                      onChange={(event) => setCode(event.target.value.trim())}
                      maxLength={43}
                      disabled={busy}
                    />
                    <button type="submit" disabled={busy || code.length !== 43}>
                      {busy ? "Claiming…" : "Claim journey"}
                    </button>
                  </div>
                </form>
              ) : phase === "needs_relogin" ? (
                <div className={styles.organizationDeletionForm}>
                  <p>
                    The claim is sealed. Sign out now, then sign back in with this same confirmed
                    email. Managed Auth must record that new login after the claim.
                  </p>
                  <div><button type="button" onClick={beginRelogin} disabled={busy}>{busy ? "Signing out…" : "Sign out and re-login"}</button></div>
                </div>
              ) : phase === "awaiting_login" ? (
                <div className={styles.organizationDeletionForm}>
                  <p>Sign in with the same confirmed email to continue. Albert will not enable receipt sealing until this browser has an authenticated session again.</p>
                  <div><a className={styles.organizationRefresh} href={`/login?next=${encodeURIComponent(`/dash/acceptance?journey=${journeyId}`)}`}>Continue to sign in</a></div>
                </div>
              ) : phase === "ready_receipt" ? (
                <div className={styles.organizationDeletionForm}>
                  <p>
                    Your post-claim login is active. Albert will match the browser-generated one-use
                    continuity nonce and bounded user-agent digest sealed when this journey was claimed.
                  </p>
                  <div><button type="button" onClick={completeReceipt} disabled={busy}>{busy ? "Sealing…" : "Seal browser receipt"}</button></div>
                </div>
              ) : (
                <div className={styles.organizationDeletionForm}>
                  <p>
                    Receipt <code>{receiptDigest?.slice(0, 12)}…</code> is sealed. Connect Lightspeed,
                    Xero, and Deputy as this owner, answer all four blocking questions, and let each
                    source reach readiness before the protected collector runs.
                  </p>
                  <div><a className={styles.organizationRefresh} href="/dash?view=Connections">Continue to Connections</a></div>
                </div>
              )}
            </section>

            <section className={styles.organizationPanel}>
              <div className={styles.organizationSectionHeading}>
                <div><span>BOUNDARY</span><h3>What is actually proved</h3></div>
              </div>
              <div className={styles.organizationDeletionForm}>
                <p>
                  Database time—not browser time—orders issuance, email confirmation, tenant creation,
                  claim, re-login, receipt, OAuth completion, blocking answers, readiness, and final capture.
                  Any replay, different user or tenant, expired journey, stale connection generation, or
                  missing managed Auth audit event fails closed.
                </p>
                {claimDigest ? <p>Claim binding <code>{claimDigest.slice(0, 12)}…</code></p> : null}
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}
