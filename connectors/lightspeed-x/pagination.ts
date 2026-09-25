export type LightspeedXPagination = Readonly<{
  kind: "version" | "offset" | "page" | "opaque" | "before_id" | "after_id" | "none";
  location: "query" | "body" | "none";
  requestField?: string;
  responseField?: string;
  pageSizeField?: string;
  pageSize?: number;
  hasNextField?: string;
  lastRecordField?: string;
  /** Version endpoints terminate only on an empty collection. */
  emptyPageTerminates?: boolean;
}>;

export type LightspeedXCursorState = Readonly<{
  position?: string;
  partitionIndex?: number;
  parentAfter?: string;
  parentIndex?: number;
  /** Stable identity/fingerprint fence for a replayed parent page. */
  parentId?: string;
  parentPageHash?: string;
  childPosition?: string;
}>;

export type LightspeedXPageAdvance = Readonly<{
  hasMore: boolean;
  nextPosition: string | null;
  block?: Readonly<{
    code: "pagination_identity_invalid" | "pagination_not_advancing";
    detail: string;
  }>;
}>;

export function decodeLightspeedXCursor(value: string | undefined): LightspeedXCursorState {
  if (!value) return {};
  if (!value.startsWith("{")) return { position: value };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      ...(typeof parsed.position === "string" ? { position: parsed.position } : {}),
      ...(Number.isSafeInteger(parsed.partitionIndex) ? { partitionIndex: Number(parsed.partitionIndex) } : {}),
      ...(typeof parsed.parentAfter === "string" ? { parentAfter: parsed.parentAfter } : {}),
      ...(Number.isSafeInteger(parsed.parentIndex) ? { parentIndex: Number(parsed.parentIndex) } : {}),
      ...(typeof parsed.parentId === "string" ? { parentId: parsed.parentId } : {}),
      ...(typeof parsed.parentPageHash === "string" ? { parentPageHash: parsed.parentPageHash } : {}),
      ...(typeof parsed.childPosition === "string" ? { childPosition: parsed.childPosition } : {}),
    };
  } catch {
    return { position: value };
  }
}

export function encodeLightspeedXCursor(state: LightspeedXCursorState): string {
  return JSON.stringify(state);
}

export function applyLightspeedXPagination(
  contract: LightspeedXPagination,
  position: string | undefined,
  query: URLSearchParams,
  body: Record<string, unknown>,
): void {
  if (contract.kind === "none") return;
  const target = contract.location === "body" ? body : query;
  const set = (key: string, value: string | number): void => {
    if (target instanceof URLSearchParams) target.set(key, String(value));
    else target[key] = typeof value === "number" ? String(value) : value;
  };
  if (position && contract.requestField) set(contract.requestField, position);
  if (contract.pageSizeField && contract.pageSize) set(contract.pageSizeField, contract.pageSize);
  if (contract.kind === "page" && !position && contract.requestField) set(contract.requestField, "1");
  if (contract.kind === "offset" && !position && contract.requestField) set(contract.requestField, "0");
}

export function advanceLightspeedXPage(
  contract: LightspeedXPagination,
  previous: string | undefined,
  response: unknown,
  records: readonly unknown[],
): LightspeedXPageAdvance {
  if (contract.kind === "none") return { hasMore: false, nextPosition: null };
  if (records.length === 0 && contract.emptyPageTerminates !== false) {
    return { hasMore: false, nextPosition: null };
  }
  let next: string | null = null;
  if (contract.kind === "version" || contract.kind === "opaque") {
    next = scalarString(valueAt(response, contract.responseField ?? "version.max"));
    // The read-only POST /inventory response is a bare array rather than the
    // standard collection envelope. Its documented continuation is the
    // greatest record version in that page.
    if (contract.kind === "version" && !next) {
      next = records
        .map((record) => scalarString(valueAt(record, "version")))
        .filter((value): value is string => value !== null)
        .sort(compareCursor)
        .at(-1) ?? null;
    }
    // Opaque endpoint cursors explicitly use an empty/missing value as their
    // terminal signal. A version collection may never do this on a non-empty
    // page: losing version.max would make the durable watermark unsafe.
    if (contract.kind === "opaque" && !next) return { hasMore: false, nextPosition: null };
  } else if (contract.kind === "offset") {
    next = (BigInt(previous ?? "0") + BigInt(records.length)).toString();
  } else if (contract.kind === "page") {
    next = (BigInt(previous ?? "1") + 1n).toString();
  } else if (contract.kind === "before_id" || contract.kind === "after_id") {
    const hasNext = contract.hasNextField ? Boolean(valueAt(response, contract.hasNextField)) : records.length > 0;
    if (!hasNext) return { hasMore: false, nextPosition: null };
    next = scalarString(valueAt(records.at(-1), contract.lastRecordField ?? "id"));
  }
  if (!next) {
    return {
      hasMore: false,
      nextPosition: null,
      block: { code: "pagination_identity_invalid", detail: `The ${contract.kind} paginator returned records without a next cursor.` },
    };
  }
  // Only numeric/page watermarks carry an ordering guarantee. Opaque cursors
  // and vendor IDs are continuation tokens: they must change, but comparing
  // their lexical spelling would reject valid traversals such as `z` -> `a`.
  const strictlyAscending = contract.kind === "version" ||
    contract.kind === "offset" || contract.kind === "page";
  if (previous !== undefined && strictlyAscending && compareCursor(next, previous) <= 0) {
    return {
      hasMore: false,
      nextPosition: null,
      block: { code: "pagination_not_advancing", detail: `Vendor cursor ${next} did not advance beyond ${previous}.` },
    };
  }
  if (previous !== undefined && next === previous) {
    return {
      hasMore: false,
      nextPosition: null,
      block: { code: "pagination_not_advancing", detail: `Vendor cursor repeated ${next}.` },
    };
  }
  return { hasMore: true, nextPosition: next };
}

export function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function compareCursor(left: string, right: string): number {
  if (/^-?\d+$/u.test(left) && /^-?\d+$/u.test(right)) {
    const a = BigInt(left); const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left.localeCompare(right);
}
