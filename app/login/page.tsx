import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginFrame } from "./login-chrome";
import LoginForm from "./login-form";
import styles from "./login.module.css";

export const metadata: Metadata = {
  title: {
    absolute: "Albert",
  },
  description: "Governed, natural-language analytics for small business.",
};

function LoginShell() {
  return (
    <LoginFrame theme="system" busy home>
      <section className={styles.loginCard} aria-labelledby="login-title">
        <div className={styles.intro}>
          <h2 id="login-title">Welcome back</h2>
          <p>Sign in to continue to your workspace.</p>
        </div>
        <div className={styles.shellFields} aria-hidden="true">
          <div className={styles.shellField} />
          <div className={styles.shellField} />
          <div className={styles.shellButton} />
        </div>
      </section>
    </LoginFrame>
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
