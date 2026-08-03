import { ConnectorError } from "./errors.js";
import type { ConnectorId, SyncCursor } from "./index.js";

export type OpaqueCursorState = Readonly<{
  v: 1;
  connector: ConnectorId;
  stream: string;
  mode: "initial" | "incremental" | "reconciliation";
  /** Last fully committed lower-bound. It must not advance during a paged window. */
  watermark?: string;
  /** Highest source timestamp observed while the current paged window is still open. */
  observedWatermark?: string;
  continuation?: string | number;
  rangeFrom?: string;
  rangeTo?: string;
}>;

export function encodeCursor(state: OpaqueCursorState): SyncCursor {
  return {
    value: Buffer.from(JSON.stringify(state), "utf8").toString("base64url"),
    sourceUpdatedAt: state.watermark,
  };
}

export function decodeCursor(
  cursor: SyncCursor,
  expected: Readonly<{ connector: ConnectorId; stream: string }>,
): OpaqueCursorState {
  try {
    const value = JSON.parse(
      Buffer.from(cursor.value, "base64url").toString("utf8"),
    ) as Partial<OpaqueCursorState>;
    if (
      value.v !== 1 ||
      value.connector !== expected.connector ||
      value.stream !== expected.stream ||
      !["initial", "incremental", "reconciliation"].includes(value.mode ?? "")
    ) {
      throw new Error("Cursor scope does not match the requested stream.");
    }
    return value as OpaqueCursorState;
  } catch (cause) {
    // A legacy ISO watermark remains safe to consume during rolling upgrades.
    if (Number.isFinite(Date.parse(cursor.value))) {
      return {
        v: 1,
        connector: expected.connector,
        stream: expected.stream,
        mode: "incremental",
        watermark: new Date(cursor.value).toISOString(),
      };
    }
    throw new ConnectorError("CURSOR_INVALID", "The stored sync cursor is invalid.", {
      cause,
      details: { connector: expected.connector, stream: expected.stream },
    });
  }
}
