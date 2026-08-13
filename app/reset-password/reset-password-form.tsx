"use client";

import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import {
  getServerThemePreference,
  getThemePreference,
  subscribeToThemePreference,
} from "@/app/theme-preference";
import { LoginFrame } from "../login/login-chrome";
import styles from "../login/login.module.css";

export default function ResetPasswordForm({ updateMode }: Readonly<{ updateMode: boolean }>) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const theme = useSyncExternalStore(
    subscribeToThemePreference,
    getThemePreference,
    getServerThemePreference,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmedPassword, setConfirmedPassword] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setStatus("");

    if (updateMode) {
      if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
        setError("Use at least 12 characters with upper and lower case letters and a number.");
        setSubmitting(false);
        return;
      }
      if (password !== confirmedPassword) {
        setError("The passwords do not match.");
        setSubmitting(false);
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError("This recovery session is invalid or expired. Request a new link.");
        setSubmitting(false);
        return;
      }
      router.replace("/dash");
      router.refresh();
      return;
    }

    const callback = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password?mode=update")}`;
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: callback });
    setStatus("If that email belongs to an Albert account, a recovery link is on its way.");
    setSubmitting(false);
  };

  return (
    <LoginFrame theme={theme}>
      <section className={styles.loginCard} aria-labelledby="reset-title">
        <div className={styles.intro}>
          <h2 id="reset-title">{updateMode ? "Choose a new password" : "Reset your password"}</h2>
          <p>{updateMode ? "Use a unique password for your Albert account." : "We’ll send a short-lived recovery link."}</p>
        </div>
        {status ? (
          <div className={styles.confirmation} role="status">
            <p>{status}</p>
            <a className={styles.submitButton} href="/login">Back to sign in</a>
          </div>
        ) : (
          <form className={styles.form} onSubmit={submit} aria-busy={submitting}>
            {updateMode ? (
              <>
                <label className={styles.field}>
                  <span>New password</span>
                  <input type="password" autoComplete="new-password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={submitting} />
                </label>
                <label className={styles.field}>
                  <span>Confirm password</span>
                  <input type="password" autoComplete="new-password" minLength={12} value={confirmedPassword} onChange={(event) => setConfirmedPassword(event.target.value)} required disabled={submitting} />
                </label>
              </>
            ) : (
              <label className={styles.field}>
                <span>Email</span>
                <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus disabled={submitting} />
              </label>
            )}
            <div className={styles.formStatus} aria-live="polite">
              {error ? <p className={styles.errorMessage} role="alert">{error}</p> : null}
            </div>
            <button className={styles.submitButton} type="submit" disabled={submitting}>
              {submitting ? "Please wait…" : updateMode ? "Update password" : "Send recovery link"}
            </button>
          </form>
        )}
        {!status ? <p className={styles.modeSwitch}><a href="/login">Back to sign in</a></p> : null}
      </section>
    </LoginFrame>
  );
}
