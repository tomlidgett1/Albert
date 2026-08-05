import styles from "./login.module.css";

export default function LoginLoading() {
  return (
    <main className={styles.loginPage} data-theme="system" aria-busy="true">
      <section className={styles.loginCard} aria-labelledby="login-loading-title">
        <div className={styles.brand} aria-label="Albert">
          <span>Albert</span>
        </div>
        <div className={styles.intro}>
          <h1 id="login-loading-title">Welcome back</h1>
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
