import styles from "./dash.module.css";

export default function DashLoading() {
  return (
    <main className={`${styles.dash} ${styles.routeShell}`} data-theme="system" aria-busy="true">
      <aside className={styles.sidebar} aria-hidden="true">
        <div className={styles.sidebarHeader}>
          <div className={styles.projectBrand}>
            <img
              className={styles.projectLogo}
              src="/logos/albert.png"
              alt=""
              width={20}
              height={20}
              decoding="async"
            />
            <span className={styles.projectName}>Albert</span>
          </div>
        </div>
        <div className={styles.sidebarActions}>
          <div className={styles.routeShellNavItem} />
          <div className={styles.routeShellNavItem} />
          <div className={styles.routeShellNavItem} />
        </div>
      </aside>
      <section className={styles.content} aria-labelledby="dash-loading-title">
        <header className={`${styles.pageHeader} ${styles.pageHeaderSimple}`}>
          <div className={styles.pageHeaderTop}>
            <h1 id="dash-loading-title">Chat</h1>
          </div>
        </header>
        <div className={styles.routeShellPanel}>
          <div className={styles.routeShellLine} />
          <div className={styles.routeShellLine} data-width="short" />
          <div className={styles.routeShellBlock} />
        </div>
      </section>
    </main>
  );
}
