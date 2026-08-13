import { LoginFrame } from "./login-chrome";
import styles from "./login.module.css";

export default function LoginLoading() {
  return (
    <LoginFrame theme="system" busy>
      <section className={styles.loginCard} aria-labelledby="login-loading-title">
        <div className={styles.intro}>
          <h2 id="login-loading-title">Welcome back</h2>
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
