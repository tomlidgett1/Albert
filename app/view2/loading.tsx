import Image from "next/image";
import styles from "../dash/dash.module.css";

export default function View2Loading() {
  return (
    <main className={`${styles.dash} ${styles.view2} ${styles.routeShell}`} data-theme="system" aria-busy="true">
      <header className={styles.view2Nav} aria-hidden="true">
        <div className={styles.view2NavLeft}>
          <div className={styles.view2Brand}>
            <Image
              className={styles.projectLogo}
              src="/logos/albert.png"
              alt=""
              width={20}
              height={20}
              unoptimized
            />
            <span className={styles.projectName}>
              <span className={styles.projectNameAlbert}>Albert</span>
              <span className={styles.projectNameProduct}>Analytics</span>
            </span>
          </div>
          <span className={styles.view2NavSlash} aria-hidden="true">/</span>
          <span className={styles.view2ConversationTitle}>New Analysis</span>
        </div>
        <div className={styles.view2NavRight}>
          <span className={styles.view2NewAnalysis}>New Analysis</span>
        </div>
      </header>

      <section className={styles.content} aria-labelledby="view2-loading-title">
        <h1 id="view2-loading-title" className="sr-only">New Analysis</h1>
        <div className={styles.chatShell}>
          <div className={styles.chatWorkspace}>
            <div className={styles.chatEmptyGrow} aria-hidden="true" />
            <div
              className={`${styles.chatComposerStack} ${styles.chatComposerStackEmpty}`}
              aria-hidden="true"
            >
              <p className={styles.chatHeroTitle}>Ask about your business</p>
              <div className={`${styles.chatComposer} ${styles.chatComposerBar} ${styles.routeShellComposer}`}>
                <span className={styles.routeShellComposerPlus} />
                <span className={styles.routeShellComposerField} />
                <span className={styles.routeShellComposerTrailing}>
                  <span className={styles.routeShellComposerChip} />
                  <span className={styles.routeShellComposerSend} />
                </span>
              </div>
            </div>
            <div className={styles.chatEmptyGrow} aria-hidden="true" />
          </div>
        </div>
      </section>
    </main>
  );
}
