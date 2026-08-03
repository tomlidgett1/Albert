"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import styles from "./login.module.css";

type Theme = "system" | "light" | "dark";
type AuthMode = "sign-in" | "sign-up";

const themeStorageKey = "albert-theme";

function isTheme(value: string | null): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function getRedirectPath() {
  const requestedPath = new URLSearchParams(window.location.search).get("next");

  if (
    !requestedPath ||
    !requestedPath.startsWith("/") ||
    requestedPath.startsWith("//") ||
    requestedPath.startsWith("/login")
  ) {
    return "/dash";
  }

  return requestedPath;
}

export default function LoginForm() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [theme, setTheme] = useState<Theme>("system");
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const syncTheme = () => {
      try {
        const storedTheme = window.localStorage.getItem(themeStorageKey);
        setTheme(isTheme(storedTheme) ? storedTheme : "system");
      } catch {
        setTheme("system");
      }
    };

    syncTheme();
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" || !session) return;
      router.replace(getRedirectPath());
      router.refresh();
    });

    return () => subscription.unsubscribe();
  }, [router, supabase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);
    const normalizedEmail = email.trim();

    if (mode === "sign-up") {
      const { data, error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/login`,
        },
      });

      if (error) {
        setErrorMessage(
          error.code === "weak_password"
            ? "Use a stronger password with at least 6 characters."
            : "We couldn’t create your account. Please try again.",
        );
        setIsSubmitting(false);
        return;
      }

      if (!data.session) {
        setConfirmationEmail(normalizedEmail);
        setPassword("");
        setIsSubmitting(false);
        return;
      }

      router.replace(getRedirectPath());
      router.refresh();
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error) {
      setErrorMessage(
        error.message === "Invalid login credentials"
          ? "Email or password is incorrect."
          : "We couldn’t sign you in. Please try again.",
      );
      setIsSubmitting(false);
      return;
    }

    router.replace(getRedirectPath());
    router.refresh();
  }

  function changeMode(nextMode: AuthMode) {
    if (isSubmitting) return;
    setMode(nextMode);
    setPassword("");
    setErrorMessage("");
    setConfirmationEmail("");
  }

  const isSignUp = mode === "sign-up";
  const title = confirmationEmail
    ? "Check your email"
    : isSignUp
      ? "Create your account"
      : "Welcome back";
  const description = confirmationEmail
    ? `We sent a confirmation link to ${confirmationEmail}.`
    : isSignUp
      ? "Use your email and a secure password to get started."
      : "Sign in to continue to your workspace.";

  return (
    <main className={styles.loginPage} data-theme={theme}>
      <section className={styles.loginCard} aria-labelledby="login-title">
        <div className={styles.brand} aria-label="Albert">
          <span>Albert</span>
        </div>

        <div className={styles.intro}>
          <h1 id="login-title">{title}</h1>
          <p>{description}</p>
        </div>

        {confirmationEmail ? (
          <div className={styles.confirmation} role="status">
            <p>Open the link in your inbox to finish creating your account.</p>
            <button
              className={styles.submitButton}
              type="button"
              onClick={() => changeMode("sign-in")}
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form
            className={styles.form}
            onSubmit={handleSubmit}
            aria-busy={isSubmitting}
          >
            <label className={styles.field}>
              <span>Email</span>
              <input
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                required
                autoFocus
                disabled={isSubmitting}
              />
            </label>

            <label className={styles.field}>
              <span>Password</span>
              <input
                type="password"
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={isSignUp ? "new-password" : "current-password"}
                placeholder={
                  isSignUp ? "Create a password" : "Enter your password"
                }
                minLength={isSignUp ? 6 : undefined}
                required
                disabled={isSubmitting}
              />
            </label>

            <div className={styles.formStatus} aria-live="polite">
              {errorMessage ? (
                <p className={styles.errorMessage} role="alert">
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="10" cy="10" r="7.5" />
                    <path d="M10 6.2v4.5M10 13.8v.1" />
                  </svg>
                  {errorMessage}
                </p>
              ) : null}
            </div>

            <button
              className={styles.submitButton}
              type="submit"
              disabled={isSubmitting}
            >
              <span>
                {isSubmitting
                  ? isSignUp
                    ? "Creating account…"
                    : "Signing in…"
                  : isSignUp
                    ? "Create account"
                    : "Sign in"}
              </span>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4.5 10h11M11.5 6l4 4-4 4" />
              </svg>
            </button>
          </form>
        )}

        {!confirmationEmail ? (
          <p className={styles.modeSwitch}>
            <span>{isSignUp ? "Already have an account?" : "New to Albert?"}</span>{" "}
            <button
              type="button"
              onClick={() => changeMode(isSignUp ? "sign-in" : "sign-up")}
              disabled={isSubmitting}
            >
              {isSignUp ? "Sign in" : "Create account"}
            </button>
          </p>
        ) : null}
      </section>
    </main>
  );
}
