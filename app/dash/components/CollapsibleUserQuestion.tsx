"use client";

import { useLayoutEffect, useRef, useState } from "react";
import styles from "../dash.module.css";

export function CollapsibleUserQuestion(props: Readonly<{
  text: string;
  orb?: React.ReactNode;
  onEdit: () => void;
}>): React.ReactNode {
  const previewRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [props.text]);

  useLayoutEffect(() => {
    const node = previewRef.current;
    if (!node || expanded) return;
    const measure = () => {
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, props.text]);

  return (
    <>
      <button
        className={styles.chatMessageUserFace}
        type="button"
        aria-label="Edit message"
        onClick={props.onEdit}
      >
        {props.text ? (
          <p ref={previewRef} data-expanded={expanded ? "true" : undefined}>{props.text}</p>
        ) : null}
        {props.orb}
      </button>
      {overflows ? (
        <button
          className={styles.chatMessageUserMore}
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}
