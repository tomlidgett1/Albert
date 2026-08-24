"use client";

import { useState, useSyncExternalStore, useEffect, useRef } from "react";
import InsightsStyleTrace from "./InsightsStyleTrace";
import {
  getNewTestChatSnapshot,
  sendNewTestQuestion,
  subscribeNewTestChat,
} from "../lib/new-test-chat-store";
import styles from "./new-test-workspace.module.css";

const starterPrompts = [
  "Give me a candid health check across sales, customers, inventory and cash",
  "What changed most in the last 90 days, and what evidence explains it?",
  "Find one high-confidence opportunity I could test this month",
] as const;

function PaperMark() {
  return (
    <svg className={styles.mark} viewBox="0 0 26 26" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16 0H4v4h12v12H4V4H0v22h16V16h10V0H16z"
      />
    </svg>
  );
}

export default function NewTestWorkspace() {
  const { turns, sending, sendError } = useSyncExternalStore(
    subscribeNewTestChat,
    getNewTestChatSnapshot,
    getNewTestChatSnapshot,
  );
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  return (
    <div className={styles.workspace} aria-label="New test">
      <header className={styles.topBar}>
        <div className={styles.brand}>
          <PaperMark />
          <span className={styles.title}>New test</span>
        </div>
        <span className={styles.credit}>Designed with paper.design</span>
      </header>
      <div className={styles.canvas}>
        <div className={styles.sheet}>
          <div className={styles.thread} ref={scrollRef}>
            {turns.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.eyebrow}>Albert chat</p>
                <h1 className={styles.headline}>Ask the business a clean question</h1>
                <p className={styles.lede}>
                  A test surface designed on paper. Answers stream here with the same Albert runtime as the main chat.
                </p>
                <div className={styles.prompts}>
                  {starterPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className={styles.prompt}
                      disabled={sending}
                      onClick={() => void sendNewTestQuestion(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : turns.map((turn) => (
              <div className={styles.turn} key={turn.id}>
                <div className={styles.user}>{turn.userMessage}</div>
                <div className={styles.assistant}>
                  <InsightsStyleTrace
                    events={turn.events}
                    streaming={turn.streaming}
                    runtime="codex"
                    onFollowUp={(prompt) => void sendNewTestQuestion(prompt)}
                  />
                </div>
              </div>
            ))}
            {sendError ? (
              <p className={styles.notice} role="alert">{sendError}</p>
            ) : null}
          </div>
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              const question = draft;
              setDraft("");
              void sendNewTestQuestion(question);
            }}
          >
            <input
              className={styles.input}
              value={draft}
              placeholder={sending ? "Albert is answering…" : "Ask about sales, cash, stock, or customers"}
              disabled={sending}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Message Albert"
            />
            <button className={styles.send} type="submit" disabled={sending || !draft.trim()}>
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
