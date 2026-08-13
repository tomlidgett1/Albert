import { Suspense } from "react";
import { LoginFrame } from "../../login/login-chrome";
import RecoverForm from "./recover-form";
import styles from "../../login/login.module.css";

function RecoverShell() {
  return (
    <LoginFrame theme="system" busy>
      <section className={styles.loginCard} aria-labelledby="recover-title">
        <div className={styles.intro}>
          <h2 id="recover-title">Continue in this browser</h2>
          <p>Albert is preparing your recovery step.</p>
        </div>
        <div className={styles.shellFields} aria-hidden="true">
          <div className={styles.shellButton} />
        </div>
      </section>
    </LoginFrame>
  );
}

function firstQueryValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value[0] ?? "" : "";
}

async function RecoverContent({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = await searchParams;
  return (
    <RecoverForm
      tokenHash={firstQueryValue(query.token_hash)}
      type={firstQueryValue(query.type)}
    />
  );
}

export default function RecoverPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  return (
    <Suspense fallback={<RecoverShell />}>
      <RecoverContent searchParams={searchParams} />
    </Suspense>
  );
}
