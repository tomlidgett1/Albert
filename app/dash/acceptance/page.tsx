import { Suspense } from "react";
import type { Metadata } from "next";
import ProtectedOnboardingAcceptance from "./protected-onboarding-acceptance";
import styles from "../dash.module.css";

export const metadata: Metadata = {
  title: "Protected onboarding acceptance",
  description: "Complete the nonce-bound production onboarding acceptance journey.",
};

function AcceptanceShell() {
  return (
    <main className={styles.dash} data-theme="system" aria-busy="true">
      <section className={styles.content} aria-labelledby="acceptance-title">
        <header className={`${styles.pageHeader} ${styles.pageHeaderSimple}`}>
          <div className={styles.pageHeaderTop}>
            <h1 id="acceptance-title">Protected onboarding</h1>
          </div>
        </header>
        <div className={styles.routeShellPanel} aria-hidden="true">
          <div className={styles.routeShellLine} />
          <div className={styles.routeShellLine} data-width="short" />
          <div className={styles.routeShellBlock} />
        </div>
      </section>
    </main>
  );
}

async function AcceptanceContent({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = await searchParams;
  const journeyId = typeof query.journey === "string" &&
      /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(query.journey)
    ? query.journey
    : null;
  return <ProtectedOnboardingAcceptance journeyId={journeyId} />;
}

export default function ProtectedOnboardingAcceptancePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  return (
    <Suspense fallback={<AcceptanceShell />}>
      <AcceptanceContent searchParams={searchParams} />
    </Suspense>
  );
}
