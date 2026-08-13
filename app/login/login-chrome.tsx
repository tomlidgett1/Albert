import type { ReactNode } from "react";
import Image from "next/image";
import LearnMoreButton from "./LearnMoreButton";
import LoginHeroBackground from "./LoginHeroBackground";
import LoginHome from "./LoginHome";
import styles from "./login.module.css";

export function LoginHero({ showLearnMore = false }: Readonly<{ showLearnMore?: boolean }>) {
  return (
    <header className={styles.hero}>
      <Image
        className={styles.brandMark}
        src="/logos/albert.png"
        alt=""
        width={72}
        height={62}
        unoptimized
        priority
      />
      <h1 className={styles.brand}>Albert</h1>
      <p className={styles.tagline}>
        Governed, natural-language analytics for small business.
      </p>
      {showLearnMore ? <LearnMoreButton /> : null}
    </header>
  );
}

export function LoginFrame({
  theme,
  children,
  busy = false,
  home = false,
}: Readonly<{
  theme: string;
  children: ReactNode;
  busy?: boolean;
  home?: boolean;
}>) {
  return (
    <main className={styles.loginPage} data-theme={theme} aria-busy={busy || undefined}>
      <div id="albert-sign-in" className={styles.loginGate}>
        <section className={styles.heroPanel} aria-label="Albert">
          <LoginHeroBackground />
          <LoginHero showLearnMore={home} />
        </section>
        <section className={styles.authPanel}>{children}</section>
      </div>
      {home ? <LoginHome /> : null}
    </main>
  );
}
