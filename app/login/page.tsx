import { Suspense } from "react";
import type { Metadata } from "next";
import LoginForm from "./login-form";
import styles from "./login.module.css";

export const metadata: Metadata = {
  title: "Sign in · Albert",
  description: "Sign in or create your Albert account.",
};

function LoginShell() {
  return (
    <main className={styles.loginPage} data-theme="system" aria-busy="true">
      <section className={styles.loginCard} aria-labelledby="login-title">
        <div className={styles.brand} aria-label="Albert">
          <span>Albert</span>
        </div>
        <div className={styles.intro}>
          <h1 id="login-title">Welcome back</h1>
          <p>Sign in to continue to your workspace.</p>
        </div>
        <div className={styles.shellFields} aria-hidden="true">
          <div className={styles.shellField} />
          <div className={styles.shellField} />
          <div className={styles.shellButton} />
        </div>
      </section>
    </main>
  );
}

async function LoginPageContent({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = await searchParams;
  return <LoginForm authError={typeof query.auth_error === "string"} />;
}

export default function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginPageContent searchParams={searchParams} />
    </Suspense>
  );
}
