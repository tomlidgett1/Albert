import Image from "next/image";
import styles from "./dash.module.css";

export default function DashLoading() {
  return (
    <main className={`${styles.dash} ${styles.routeShell}`} data-theme="system" aria-busy="true">
      <aside className={styles.sidebar} aria-hidden="true">
        <div className={styles.sidebarHeader}>
          <div className={styles.projectBrand}>
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
        </div>

        <div className={styles.sidebarActions}>
          <div className={styles.sidebarAction}>
            <span className={styles.routeShellNavGlyph} />
            <span className={styles.sidebarActionLabel}>New Analysis</span>
          </div>
          <div className={styles.sidebarAction}>
            <span className={styles.routeShellNavGlyph} />
            <span className={styles.sidebarActionLabel}>Search</span>
          </div>
        </div>

        <nav className={styles.conversationNav} aria-hidden="true">
          <div
            className={styles.conversationNavSkeleton}
            role="status"
            aria-label="Loading conversations"
            data-state="loading"
          >
            <div className={`${styles.conversationNavSkeletonLayer} ${styles.isPulsing}`}>
              <div className={styles.conversationNavSkeletonItem} />
              <div className={styles.conversationNavSkeletonItem} data-width="mid" />
              <div className={styles.conversationNavSkeletonItem} data-width="short" />
              <div className={styles.conversationNavSkeletonItem} />
              <div className={styles.conversationNavSkeletonItem} data-width="mid" />
            </div>
          </div>
        </nav>

        <div className={styles.accountArea}>
          <div className={styles.accountBar}>
            <div className={styles.routeShellAccountTrigger}>
              <span className={styles.routeShellAccountAvatar} />
              <span className={styles.routeShellAccountCopy}>
                <span className={styles.routeShellLine} data-width="account" />
                <span className={styles.routeShellLine} data-width="role" />
              </span>
            </div>
            <span className={styles.routeShellIconButton} aria-hidden="true" />
          </div>
        </div>
      </aside>

      <section className={styles.content} aria-labelledby="dash-loading-title">
        <div className={styles.chatShell}>
          <div className={styles.chatWorkspace}>
            <header className={styles.chatTopBar}>
              <h1 id="dash-loading-title" className={styles.chatTopTitle}>
                New Analysis
              </h1>
              <div className={styles.chatTopActions}>
                <span className={styles.routeShellIconButton} aria-hidden="true" />
              </div>
            </header>

            <div className={styles.chatEmptyGrow} aria-hidden="true" />

            <div
              className={`${styles.chatComposerStack} ${styles.chatComposerStackEmpty}`}
              aria-hidden="true"
            >
              <p className={styles.chatHeroTitle}>Ask me anything</p>
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
