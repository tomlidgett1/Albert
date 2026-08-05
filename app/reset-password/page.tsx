import { Suspense } from "react";
import ResetPasswordForm from "./reset-password-form";
import loginStyles from "../login/login.module.css";

function ResetPasswordShell() {
  return (
    <main className={loginStyles.loginPage} data-theme="system" aria-busy="true">
      <section className={loginStyles.loginCard} aria-labelledby="reset-title">
        <div className={loginStyles.brand} aria-label="Albert">
          <span>Albert</span>
        </div>
        <div className={loginStyles.intro}>
          <h1 id="reset-title">Reset password</h1>
          <p>Choose a new password for your Albert account.</p>
        </div>
        <div className={loginStyles.shellFields} aria-hidden="true">
          <div className={loginStyles.shellField} />
          <div className={loginStyles.shellField} />
          <div className={loginStyles.shellButton} />
        </div>
      </section>
    </main>
  );
}

async function ResetPasswordContent({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = await searchParams;
  return <ResetPasswordForm updateMode={query.mode === "update"} />;
}

export default function ResetPasswordPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  return (
    <Suspense fallback={<ResetPasswordShell />}>
      <ResetPasswordContent searchParams={searchParams} />
    </Suspense>
  );
}
