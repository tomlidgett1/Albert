"use client";

import { useMemo, useState } from "react";
import styles from "./semantic-admin.module.css";

type RelationshipGraphObject = Record<string, unknown> & {
  id?: string;
  label?: string;
  disposition?: string;
  semanticState?: string;
};

export type RelationshipGraphPayload = Readonly<{
  nodes: readonly Readonly<{
    id: string;
    label: string;
    grain: string;
    group: string;
    semanticState: string;
  }>[];
  edges: readonly Readonly<{
    id: string;
    objectId: string;
    fromViewId: string;
    toViewId: string;
    fromFieldId: string;
    toFieldId: string;
    kind: "relationship" | "candidate";
    status: "supported" | "verified" | "unresolved" | "rejected";
    cardinality: string | null;
    matchKind: string | null;
  }>[];
  objects: readonly RelationshipGraphObject[];
  counts: Readonly<{
    views: number;
    supported: number;
    unresolved: number;
    rejected: number;
    conflicts: number;
    fanoutWarnings: number;
  }>;
}>;

type PositionedNode = Readonly<{
  id: string;
  x: number;
  y: number;
}>;

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function compact(value: string): string {
  return value.length > 34 ? `${value.slice(0, 31)}…` : value;
}

export default function SemanticRelationshipGraph({
  graph,
  selectedObjectId,
  onSelectObject,
}: {
  graph: RelationshipGraphPayload;
  selectedObjectId?: string | null;
  onSelectObject: (object: RelationshipGraphObject) => void;
}) {
  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graph.edges) {
      counts.set(edge.fromViewId, (counts.get(edge.fromViewId) ?? 0) + 1);
      counts.set(edge.toViewId, (counts.get(edge.toViewId) ?? 0) + 1);
    }
    return counts;
  }, [graph.edges]);
  const initialFocus = useMemo(
    () =>
      [...graph.nodes].sort(
        (left, right) =>
          (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
          left.label.localeCompare(right.label),
      )[0]?.id ?? "",
    [degree, graph.nodes],
  );
  const [focusId, setFocusId] = useState(initialFocus);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [status, setStatus] = useState("all");
  const resolvedFocusId = graph.nodes.some(({ id }) => id === focusId)
    ? focusId
    : initialFocus;

  const groups = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.group))].sort(),
    [graph.nodes],
  );
  const filteredEdges = useMemo(
    () =>
      graph.edges.filter((edge) => status === "all" || edge.status === status),
    [graph.edges, status],
  );
  const connectedIds = useMemo(() => {
    const values = new Set<string>();
    for (const edge of filteredEdges) {
      values.add(edge.fromViewId);
      values.add(edge.toViewId);
    }
    return values;
  }, [filteredEdges]);
  const visibleNodes = useMemo(() => {
    const token = query.trim().toLowerCase();
    return graph.nodes
      .filter(
        (node) =>
          (group === "all" || node.group === group) &&
          connectedIds.has(node.id) &&
          (!token ||
            `${node.label} ${node.id} ${node.grain}`
              .toLowerCase()
              .includes(token)),
      )
      .sort(
        (left, right) =>
          (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
          left.label.localeCompare(right.label),
      );
  }, [connectedIds, degree, graph.nodes, group, query]);
  const focusNode =
    graph.nodes.find(({ id }) => id === resolvedFocusId) ?? null;
  const focusEdges = filteredEdges.filter(
    ({ fromViewId, toViewId }) =>
      fromViewId === resolvedFocusId || toViewId === resolvedFocusId,
  );
  const neighbourIds = [
    ...new Set(
      focusEdges.map(({ fromViewId, toViewId }) =>
        fromViewId === resolvedFocusId ? toViewId : fromViewId,
      ),
    ),
  ].slice(0, 24);
  const positions: PositionedNode[] = neighbourIds.map((id, index) => {
    const angle = (index / Math.max(1, neighbourIds.length)) * Math.PI * 2;
    return {
      id,
      x: 500 + Math.cos(angle) * 395,
      y: 280 + Math.sin(angle) * 210,
    };
  });
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const drawnEdges = focusEdges.filter((edge) =>
    positionById.has(
      edge.fromViewId === resolvedFocusId
        ? edge.toViewId
        : edge.fromViewId,
    ),
  );
  const objectById = new Map(
    graph.objects.flatMap((object) =>
      typeof object.id === "string" ? [[object.id, object] as const] : [],
    ),
  );

  return (
    <section className={styles.relationshipGraph} aria-label="Semantic relationship graph">
      <header>
        <div>
          <span>JOIN SAFETY MAP</span>
          <h3>Navigable semantic graph</h3>
          <p>
            Explore every governed view and candidate edge. A visible candidate is
            not executable until live profiling, review, and publication succeed.
          </p>
        </div>
        <dl>
          <div><dt>Views</dt><dd>{graph.counts.views}</dd></div>
          <div data-state="verified"><dt>Supported</dt><dd>{graph.counts.supported}</dd></div>
          <div data-state="unresolved"><dt>Unresolved</dt><dd>{graph.counts.unresolved}</dd></div>
          <div><dt>Conflicts</dt><dd>{graph.counts.conflicts}</dd></div>
          <div><dt>Fan-out warnings</dt><dd>{graph.counts.fanoutWarnings}</dd></div>
        </dl>
      </header>
      <div className={styles.graphControls}>
        <label>
          <span className="sr-only">Search graph views</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search views, grains or ids…"
          />
        </label>
        <label>
          <span className="sr-only">Graph domain</span>
          <select value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="all">All domains</option>
            {groups.map((entry) => <option value={entry} key={entry}>{entry}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Graph relationship status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All edge states</option>
            <option value="supported">Supported</option>
            <option value="verified">Verified candidates</option>
            <option value="unresolved">Unresolved</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </div>
      <div className={styles.relationshipGraphBody}>
        <nav aria-label="Relationship graph views" className={styles.graphNodeList}>
          <small>{visibleNodes.length} connected views</small>
          {visibleNodes.slice(0, 300).map((node) => (
            <button
              type="button"
              key={node.id}
              aria-current={node.id === resolvedFocusId ? "true" : undefined}
              onClick={() => setFocusId(node.id)}
            >
              <span className={styles.stateDot} data-state={node.semanticState} />
              <span>
                <strong>{node.label}</strong>
                <small>{node.group} · {degree.get(node.id) ?? 0} edges</small>
              </span>
            </button>
          ))}
        </nav>
        <div className={styles.graphCanvasColumn}>
          <div className={styles.graphCanvas} role="group" aria-label={
            focusNode
              ? `${focusNode.label} and ${neighbourIds.length} connected views`
              : "No connected semantic view selected"
          }>
            <svg viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
              {drawnEdges.map((edge) => {
                const otherId =
                  edge.fromViewId === resolvedFocusId
                    ? edge.toViewId
                    : edge.fromViewId;
                const target = positionById.get(otherId)!;
                const parallel = drawnEdges.filter((candidate) =>
                  [candidate.fromViewId, candidate.toViewId].includes(otherId),
                );
                const parallelIndex = parallel.findIndex(({ id }) => id === edge.id);
                const offset = (parallelIndex - (parallel.length - 1) / 2) * 5;
                return (
                  <line
                    key={edge.id}
                    x1={500 + offset}
                    y1={280 + offset}
                    x2={target.x + offset}
                    y2={target.y + offset}
                    data-status={edge.status}
                  />
                );
              })}
            </svg>
            {focusNode ? (
              <div className={styles.graphFocusNode} title={focusNode.id}>
                <strong>{compact(focusNode.label)}</strong>
                <small>{focusEdges.length} visible edges</small>
              </div>
            ) : null}
            {positions.map((position) => {
              const node = graph.nodes.find(({ id }) => id === position.id);
              if (!node) return null;
              return (
                <button
                  type="button"
                  className={styles.graphNeighbourNode}
                  key={node.id}
                  title={`${node.label} · ${node.id}`}
                  style={{ left: `${position.x / 10}%`, top: `${position.y / 5.6}%` }}
                  onClick={() => setFocusId(node.id)}
                >
                  {compact(node.label)}
                </button>
              );
            })}
          </div>
          {focusEdges.length > 24 ? (
            <p className={styles.graphOverflowNote}>
              Showing 24 of {new Set(focusEdges.map(({ objectId }) => objectId)).size} connected objects. Use the filters or edge list to narrow the graph.
            </p>
          ) : null}
          <div className={styles.graphEdgeList} aria-label="Focused relationship edges">
            {focusEdges.length ? focusEdges.slice(0, 200).map((edge) => {
              const otherId =
                edge.fromViewId === resolvedFocusId
                  ? edge.toViewId
                  : edge.fromViewId;
              const other = graph.nodes.find(({ id }) => id === otherId);
              const object = objectById.get(edge.objectId);
              return (
                <button
                  type="button"
                  key={edge.id}
                  data-state={edge.status}
                  aria-current={selectedObjectId === edge.objectId ? "true" : undefined}
                  onClick={() => object && onSelectObject(object)}
                >
                  <span className={styles.stateDot} data-state={edge.status} />
                  <span>
                    <strong>{other?.label ?? otherId}</strong>
                    <small>{compact(edge.fromFieldId)} → {compact(edge.toFieldId)}</small>
                  </span>
                  <em>{humanize(edge.cardinality ?? edge.matchKind ?? edge.status)}</em>
                </button>
              );
            }) : (
              <p>No edges match the current focus and status filter.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
