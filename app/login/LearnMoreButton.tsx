"use client";

import { scrollToLoginHome } from "./LoginHome";
import styles from "./login.module.css";

export default function LearnMoreButton() {
  return (
    <button type="button" className={styles.learnMore} onClick={scrollToLoginHome}>
      Learn more
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.5v9M4.5 9.5 8 13l3.5-3.5" />
      </svg>
    </button>
  );
}
