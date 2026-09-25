"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import {
  getServerThemePreference,
  getThemePreference,
  subscribeToThemePreference,
} from "@/app/theme-preference";
import { LoginFrame } from "../../login/login-chrome";
import styles from "../../login/login.module.css";

const allowedTypes = new Set(["recovery", "signup", "email"]);

function destinationFor(type: string): string {
  return type === "recovery" ? "/reset-password?mode=update" : "/dash";
}

export default function RecoverForm({
  tokenHash,
  type,
}: Readonly<{ tokenHash: string; type: string }>) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const theme = useSyncExternalStore(
    subscribeToThemePreference,
    getThemePreference,
    getServerThemePreference,
  );
  const [error, setError] = useState(
    tokenHash && allowedTypes.has(type)
      ? ""
      : "This recovery link is missing its one-time token. Request a new reset email.",
  );
  const [submitting, setSubmitting] = useState(false);
  const canContinue = Boolean(tokenHash) && allowedTypes.has(type) && !submitting;

  const continueRecovery = async () => {
    if (!canContinue) return;
    setSubmitting(true);
    setError("");
    const { error: verifyError } = await supabase.auth.verifyOtp({
      type: type as "recovery" | "signup" | "email",
      token_hash: tokenHash,
    });
    if (verifyError) {
      setError("This link is invalid or has expired. Request a new reset email and open it in this browser.");
      setSubmitting(false);
      return;
    }
    router.replace(destinationFor(type));
    router.refresh();
  };

  return (
    <LoginFrame theme={theme}>
      <section className={styles.loginCard} aria-labelledby="recover-title">
        <div className={styles.intro}>
          <h2 id="recover-title">Continue in this browser</h2>
          <p>
            Email scanners often open reset links before you do. Albert waits for this
            button so the one-time token is not used until you are ready.
          </p>
        </div>
        <div className={styles.formStatus} aria-live="polite">
          {error ? <p className={styles.errorMessage} role="alert">{error}</p> : null}
        </div>
        <button
          className={styles.submitButton}
          type="button"
          onClick={() => void continueRecovery()}
          disabled={!canContinue}
        >
          {submitting ? "Please wait…" : type === "recovery" ? "Choose a new password" : "Continue to Albert"}
        </button>
        <p className={styles.modeSwitch}><a href="/reset-password">Request a new link</a></p>
      </section>
    </LoginFrame>
  );
}
