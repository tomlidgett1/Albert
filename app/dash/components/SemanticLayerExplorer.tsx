"use client";

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import styles from "./semantic-admin.module.css";

type SemanticMember = Readonly<{
  id: string;
  name: string;
  title: string;
  kind: string;
  type: string | null;
  description: string | null;
  aiContext: string | null;
  sql: string | null;
  format: string | null;
  public: boolean | null;
  primaryKey: boolean;
  sourceCube: string;
  sourcePath: string;
  sourceMember?: string;
  alias: string | null;
  resolved: boolean;
  properties: Readonly<Record<string, unknown>>;
}>;

type SemanticEntity = Readonly<{
  id: string;
  kind: "cube" | "view";
  appId: string;
  name: string;
  title: string;
  description: string | null;
  aiContext: string | null;
  public: boolean | null;
  sql: string | null;
  sourceFile: string;
  meta: Readonly<Record<string, unknown>>;
  access: Readonly<{
    connector: string | null;
    guidance: string | null;
    purpose: string | null;
    routingTerms: readonly string[];
    keyMetrics: readonly string[];
  }> | null;
  counts: Readonly<{
    dimensions: number;
    measures: number;
    segments: number;
    exposed: number;
    joins: number;
    sources: number;
    folders: number;
  }>;
  members: readonly SemanticMember[];
  joins: readonly Readonly<{
    name: string;
    relationship: string | null;
    sql: string | null;
    properties: Readonly<Record<string, unknown>>;
  }>[];
  sources: readonly Readonly<{
    joinPath: string;
    prefix: boolean;
    includeCount: number;
    properties: Readonly<Record<string, unknown>>;
  }>[];
  folders: readonly Readonly<{
    name: string;
    includes: readonly string[];
    properties: Readonly<Record<string, unknown>>;
  }>[];
  definitionYaml: string;
  searchText: string;
}>;

type KnowledgeRule = Readonly<{
  name: string;
  kind: "always" | "agent_requested";
  description: string | null;
  body: string;
  appIds: readonly string[];
}>;

type CertifiedQuery = Readonly<{
  name: string;
  userRequest: string;
  notes: string;
  query: unknown;
  viewNames: readonly string[];
  appIds: readonly string[];
}>;

type AgentSkill = Readonly<{
  name: string;
  title: string;
  description: string;
  body: string;
  appIds: readonly string[];
}>;

type SemanticCatalogue = Readonly<{
  generatedAt: string;
  sourceOfTruth: string;
  summary: Readonly<{
    apps: number;
    files: number;
    cubes: number;
    views: number;
    dimensions: number;
    measures: number;
    segments: number;
    viewExposures: number;
    joins: number;
    rules: number;
    certifiedQueries: number;
    skills: number;
  }>;
  apps: readonly Readonly<{
    id: string;
    label: string;
    description: string;
    cubeCount: number;
    viewCount: number;
    memberCount: number;
    fileCount: number;
  }>[];
  entities: readonly SemanticEntity[];
  files: readonly Readonly<{
    path: string;
    kind: "cube" | "view";
    raw: string;
  }>[];
  knowledge: Readonly<{
    runtime: Readonly<{
      version: unknown;
      lanes: Readonly<Record<string, unknown>>;
      defaults: Readonly<Record<string, unknown>>;
      accessibleViewCount: number;
    }>;
    rules: readonly KnowledgeRule[];
    certifiedQueries: readonly CertifiedQuery[];
    skills: readonly AgentSkill[];
  }>;
}>;

type LoadState =
  | Readonly<{ kind: "loading"; message: string }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; message: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCatalogue(value: unknown): SemanticCatalogue | null {
  if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.knowledge)) return null;
  if (!Array.isArray(value.apps) || !Array.isArray(value.entities) || !Array.isArray(value.files)) return null;
  if (typeof value.generatedAt !== "string" || typeof value.sourceOfTruth !== "string") return null;
  return value as unknown as SemanticCatalogue;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-AU").format(value);
}

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
}

function formatTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return "Unknown";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unavailable";
  }
}

function propertiesWithout(
  properties: Readonly<Record<string, unknown>>,
  excluded: readonly string[],
) {
  const excludedKeys = new Set(excluded);
  return Object.entries(properties).filter(([key]) => !excludedKeys.has(key));
}

function PropertyRows({
  properties,
  excluded = [],
}: Readonly<{
  properties: Readonly<Record<string, unknown>>;
  excluded?: readonly string[];
}>) {
  const rows = propertiesWithout(properties, excluded);
  if (!rows.length) return null;
  return (
    <dl className={styles.explorerProperties}>
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{humanize(key)}</dt>
          <dd>
            {typeof value === "object" && value !== null
              ? <pre>{stringify(value)}</pre>
              : <code>{stringify(value)}</code>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MemberRow({ member }: Readonly<{ member: SemanticMember }>) {
  return (
    <details className={styles.memberRow}>
      <summary>
        <span>
          <strong>{member.name}</strong>
          <small>{member.title}{member.description ? ` · ${member.description}` : ""}</small>
        </span>
        <span>
          {member.primaryKey ? <em>Primary key</em> : null}
          <em>{humanize(member.kind)}</em>
          {member.type ? <em>{humanize(member.type)}</em> : null}
        </span>
      </summary>
      <div className={styles.memberBody}>
        <dl className={styles.memberFacts}>
          <div><dt>Fully qualified</dt><dd><code>{member.id}</code></dd></div>
          <div><dt>Source cube</dt><dd><code>{member.sourceCube}</code></dd></div>
          <div><dt>Join path</dt><dd><code>{member.sourcePath}</code></dd></div>
          {member.sourceMember ? <div><dt>Source member</dt><dd><code>{member.sourceMember}</code></dd></div> : null}
          {member.alias ? <div><dt>Published alias</dt><dd><code>{member.alias}</code></dd></div> : null}
          <div><dt>Definition resolution</dt><dd>{member.resolved ? "Resolved" : "Not resolved"}</dd></div>
          {member.format ? <div><dt>Format</dt><dd><code>{member.format}</code></dd></div> : null}
          {member.public !== null ? <div><dt>Public</dt><dd>{member.public ? "Yes" : "No"}</dd></div> : null}
        </dl>
        {member.description ? <p>{member.description}</p> : null}
        {member.aiContext ? (
          <div className={styles.guidanceBlock}>
            <strong>AI context</strong>
            <p>{member.aiContext}</p>
          </div>
        ) : null}
        {member.sql ? (
          <div className={styles.codeSection}>
            <strong>SQL expression</strong>
            <pre>{member.sql}</pre>
          </div>
        ) : null}
        <PropertyRows
          properties={member.properties}
          excluded={["name", "title", "description", "type", "format", "sql", "meta"]}
        />
      </div>
    </details>
  );
}

function ModelDefinition({
  entity,
  rawFile,
}: Readonly<{
  entity: SemanticEntity;
  rawFile: string | null;
}>) {
  const [memberQuery, setMemberQuery] = useState("");
  const [memberKind, setMemberKind] = useState("all");
  const deferredMemberQuery = useDeferredValue(memberQuery.trim().toLowerCase());
  const visibleMembers = useMemo(() => entity.members.filter((member) => {
    if (memberKind !== "all" && member.kind !== memberKind) return false;
    if (!deferredMemberQuery) return true;
    const haystack = [
      member.id,
      member.title,
      member.description,
      member.sourceCube,
      member.sourcePath,
      member.type,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(deferredMemberQuery);
  }), [deferredMemberQuery, entity.members, memberKind]);

  return (
    <article className={`${styles.inspector} ${styles.entityInspector}`} aria-label={`${entity.title} definition`}>
      <header className={styles.entityHeader}>
        <div>
          <span>{entity.kind.toUpperCase()}</span>
          <h3>{entity.title}</h3>
          <code>{entity.name}</code>
        </div>
        <div>
          <span className={styles.badge} data-state={entity.kind === "view" ? "derived" : undefined}>
            {entity.kind === "view" ? "Query surface" : entity.public ? "Public cube" : "Internal cube"}
          </span>
          {entity.access ? <span className={styles.badge} data-state="derived">Agent accessible</span> : null}
        </div>
      </header>

      {entity.description ? <p>{entity.description}</p> : null}

      <dl className={styles.entityFacts}>
        <div><dt>App</dt><dd>{humanize(entity.appId)}</dd></div>
        <div><dt>Source file</dt><dd><code>{entity.sourceFile}</code></dd></div>
        <div><dt>Fields</dt><dd>{formatNumber(entity.members.length)}</dd></div>
        <div><dt>{entity.kind === "view" ? "Source paths" : "Joins"}</dt><dd>{entity.kind === "view" ? entity.counts.sources : entity.counts.joins}</dd></div>
        <div><dt>Folders</dt><dd>{entity.counts.folders}</dd></div>
        <div><dt>Visibility</dt><dd>{entity.kind === "view" ? "Published view" : entity.public ? "Public" : "Internal"}</dd></div>
      </dl>

      {entity.access?.guidance ? (
        <section className={styles.guidanceBlock}>
          <strong>Agent routing guidance</strong>
          <p>{entity.access.guidance}</p>
          {entity.access.routingTerms.length ? (
            <div className={styles.tokenList}>
              {entity.access.routingTerms.map((term) => <code key={term}>{term}</code>)}
            </div>
          ) : null}
        </section>
      ) : null}

      {entity.aiContext ? (
        <section className={styles.guidanceBlock}>
          <strong>Model AI context</strong>
          <p>{entity.aiContext}</p>
        </section>
      ) : null}

      <section className={styles.membersSection} aria-label={`${entity.name} fields`}>
        <header>
          <div>
            <strong>{entity.kind === "view" ? "Exposed fields" : "Dimensions, measures and segments"}</strong>
            <small>{visibleMembers.length} of {entity.members.length}</small>
          </div>
          <div>
            <input
              aria-label="Search fields"
              placeholder="Search fields…"
              value={memberQuery}
              onChange={(event) => setMemberQuery(event.target.value)}
            />
            <select
              aria-label="Filter field kind"
              value={memberKind}
              onChange={(event) => setMemberKind(event.target.value)}
            >
              <option value="all">All field types</option>
              <option value="measure">Measures</option>
              <option value="dimension">Dimensions</option>
              <option value="segment">Segments</option>
              <option value="exposed">Unresolved exposures</option>
            </select>
          </div>
        </header>
        <div className={styles.memberList}>
          {visibleMembers.map((member) => <MemberRow member={member} key={member.id} />)}
          {!visibleMembers.length ? <p>No fields match this filter.</p> : null}
        </div>
      </section>

      {entity.sources.length ? (
        <section className={styles.definitionSection}>
          <h4>View source paths</h4>
          <p>Every Cube join path and its declared member exposure.</p>
          <div className={styles.definitionRows}>
            {entity.sources.map((source) => (
              <details key={source.joinPath}>
                <summary>
                  <code>{source.joinPath}</code>
                  <span>{source.includeCount} fields · prefix {source.prefix ? "on" : "off"}</span>
                </summary>
                <PropertyRows properties={source.properties} />
              </details>
            ))}
          </div>
        </section>
      ) : null}

      {entity.joins.length ? (
        <section className={styles.definitionSection}>
          <h4>Relationships</h4>
          <p>Declared cube joins, cardinalities and exact join expressions.</p>
          <div className={styles.definitionRows}>
            {entity.joins.map((join) => (
              <details key={join.name}>
                <summary>
                  <code>{join.name}</code>
                  <span>{join.relationship ? humanize(join.relationship) : "Relationship"}</span>
                </summary>
                {join.sql ? <pre>{join.sql}</pre> : null}
                <PropertyRows properties={join.properties} excluded={["name", "relationship", "sql"]} />
              </details>
            ))}
          </div>
        </section>
      ) : null}

      {entity.folders.length ? (
        <section className={styles.definitionSection}>
          <h4>Folders</h4>
          <p>The published grouping used to organise this view&apos;s fields.</p>
          <div className={styles.folderGrid}>
            {entity.folders.map((folder) => (
              <details key={folder.name}>
                <summary>{folder.name} <span>{folder.includes.length}</span></summary>
                <div className={styles.tokenList}>
                  {folder.includes.map((include) => <code key={include}>{include}</code>)}
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      {entity.sql ? (
        <section className={styles.codeSection}>
          <strong>Cube source SQL</strong>
          <pre>{entity.sql}</pre>
        </section>
      ) : null}

      {Object.keys(entity.meta).length ? (
        <section className={styles.definitionSection}>
          <h4>Metadata</h4>
          <PropertyRows properties={entity.meta} />
        </section>
      ) : null}

      <details className={styles.rawDefinition}>
        <summary>Full parsed definition (YAML)</summary>
        <p>This is the complete selected cube/view definition after YAML parsing.</p>
        <pre>{entity.definitionYaml}</pre>
      </details>

      <details className={styles.rawDefinition}>
        <summary>Exact source file</summary>
        <p>Comments, ordering and every other entity in <code>{entity.sourceFile}</code>.</p>
        <pre>{rawFile ?? "Source file is unavailable."}</pre>
      </details>
    </article>
  );
}

function appliesToApp(appIds: readonly string[], appId: string): boolean {
  return appId === "all" || appIds.length === 0 || appIds.includes(appId);
}

function AgentKnowledge({
  catalogue,
  appId,
  selectedEntity,
}: Readonly<{
  catalogue: SemanticCatalogue;
  appId: string;
  selectedEntity: SemanticEntity | null;
}>) {
  const rules = catalogue.knowledge.rules.filter((item) => appliesToApp(item.appIds, appId));
  const skills = catalogue.knowledge.skills.filter((item) => appliesToApp(item.appIds, appId));
  const queries = catalogue.knowledge.certifiedQueries.filter((item) => (
    selectedEntity?.kind === "view"
      ? item.viewNames.includes(selectedEntity.name)
      : appliesToApp(item.appIds, appId)
  ));
  return (
    <section className={styles.knowledgePanel} aria-label="Agent semantic knowledge">
      <header>
        <div>
          <span>AGENT KNOWLEDGE</span>
          <h3>{selectedEntity?.kind === "view" ? `${selectedEntity.title} query guidance` : `${appId === "all" ? "All apps" : humanize(appId)} knowledge`}</h3>
          <p>Compiled from <code>cube-playground/agents</code>: routing rules, analytical skills and certified Cube queries.</p>
        </div>
        <dl>
          <div><dt>Rules</dt><dd>{rules.length}</dd></div>
          <div><dt>Skills</dt><dd>{skills.length}</dd></div>
          <div><dt>Certified queries</dt><dd>{queries.length}</dd></div>
        </dl>
      </header>
      <div className={styles.knowledgeColumns}>
        <section>
          <h4>Rules</h4>
          {rules.map((rule) => (
            <details key={`${rule.kind}:${rule.name}`}>
              <summary><span>{humanize(rule.name)}</span><em>{humanize(rule.kind)}</em></summary>
              {rule.description ? <p>{rule.description}</p> : null}
              <pre>{rule.body}</pre>
            </details>
          ))}
          {!rules.length ? <p>No app-specific rules.</p> : null}
        </section>
        <section>
          <h4>Skills</h4>
          {skills.map((skill) => (
            <details key={skill.name}>
              <summary><span>{skill.title}</span><em>Skill</em></summary>
              <p>{skill.description}</p>
              <pre>{skill.body}</pre>
            </details>
          ))}
          {!skills.length ? <p>No app-specific skills.</p> : null}
        </section>
        <section>
          <h4>Certified queries</h4>
          {queries.map((query) => (
            <details key={query.name}>
              <summary><span>{humanize(query.name)}</span><em>Certified</em></summary>
              <p>{query.userRequest}</p>
              <pre>{stringify(query.query)}</pre>
              {query.notes ? <p>{query.notes}</p> : null}
            </details>
          ))}
          {!queries.length ? <p>No certified query targets this selection.</p> : null}
        </section>
      </div>
      <details className={styles.rawDefinition}>
        <summary>Runtime lanes and defaults</summary>
        <pre>{stringify(catalogue.knowledge.runtime)}</pre>
      </details>
    </section>
  );
}

export default function SemanticLayerExplorer({
  refreshToken = 0,
}: Readonly<{ refreshToken?: number }>) {
  const [catalogue, setCatalogue] = useState<SemanticCatalogue | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({
    kind: "loading",
    message: "Loading the tracked Cube model…",
  });
  const [appId, setAppId] = useState("all");
  const [entityKind, setEntityKind] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => {
      setLoadState({ kind: "loading", message: "Loading the tracked Cube model…" });
      void fetch("/api/admin/semantic-layer", {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await response.json().catch(() => null) as Readonly<{
          catalogue?: unknown;
          error?: string;
        }> | null;
        if (!response.ok) throw new Error(payload?.error || "The semantic layer could not be loaded.");
        const parsed = parseCatalogue(payload?.catalogue);
        if (!parsed) throw new Error("The semantic layer returned an invalid response.");
        setCatalogue(parsed);
        setLoadState({ kind: "ready", message: `Loaded ${parsed.summary.cubes} cubes and ${parsed.summary.views} views.` });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({
          kind: "error",
          message: error instanceof Error ? error.message : "The semantic layer could not be loaded.",
        });
      });
    }, 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [refreshToken]);

  const filteredEntities = useMemo(() => (catalogue?.entities ?? []).filter((entity) => {
    if (appId !== "all" && entity.appId !== appId) return false;
    if (entityKind !== "all" && entity.kind !== entityKind) return false;
    return !deferredQuery || entity.searchText.includes(deferredQuery);
  }), [appId, catalogue?.entities, deferredQuery, entityKind]);

  const selectedEntity = useMemo(() => (
    filteredEntities.find(({ id }) => id === selectedEntityId)
    ?? filteredEntities[0]
    ?? null
  ), [filteredEntities, selectedEntityId]);
  const rawFile = selectedEntity
    ? catalogue?.files.find(({ path }) => path === selectedEntity.sourceFile)?.raw ?? null
    : null;

  if (!catalogue) {
    return (
      <section className={styles.workspace} aria-label="Semantic layer explorer">
        <div className={loadState.kind === "error" ? styles.notice : styles.loading} role={loadState.kind === "error" ? "alert" : "status"}>
          {loadState.message}
        </div>
      </section>
    );
  }

  const summary = catalogue.summary;
  return (
    <section className={styles.workspace} aria-label="Semantic layer explorer">
      <div className={styles.explorerIntro}>
        <div>
          <span>PRODUCTION SOURCE OF TRUTH</span>
          <h2>Complete semantic model</h2>
          <p>
            Every tracked Cube definition, published view, field exposure, join, folder,
            SQL expression and compiled agent instruction. The exact YAML remains available
            on every object as the completeness backstop.
          </p>
        </div>
        <div>
          <code>{catalogue.sourceOfTruth}</code>
          <small>Snapshot built {formatTime(catalogue.generatedAt)}</small>
        </div>
      </div>

      <dl className={styles.summaryGrid}>
        <div><dt>Apps</dt><dd>{summary.apps}</dd><small>Source systems represented</small></div>
        <div><dt>Cubes</dt><dd>{formatNumber(summary.cubes)}</dd><small>Internal semantic objects</small></div>
        <div><dt>Views</dt><dd>{formatNumber(summary.views)}</dd><small>Published query surfaces</small></div>
        <div><dt>Cube fields</dt><dd>{formatNumber(summary.dimensions + summary.measures + summary.segments)}</dd><small>{formatNumber(summary.measures)} measures · {formatNumber(summary.dimensions)} dimensions</small></div>
        <div><dt>View exposures</dt><dd>{formatNumber(summary.viewExposures)}</dd><small>Resolved aliases and source paths</small></div>
        <div><dt>Knowledge</dt><dd>{formatNumber(summary.rules + summary.certifiedQueries + summary.skills)}</dd><small>{summary.certifiedQueries} certified queries · {summary.rules} rules</small></div>
      </dl>

      <nav className={styles.appGrid} aria-label="Semantic layer apps">
        <button
          type="button"
          className={appId === "all" ? styles.appButtonActive : undefined}
          aria-current={appId === "all" ? "page" : undefined}
          onClick={() => {
            setAppId("all");
            setSelectedEntityId(null);
          }}
        >
          <strong>All apps</strong>
          <span>{countLabel(summary.cubes, "cube")} · {countLabel(summary.views, "view")}</span>
          <small>Browse the complete production model.</small>
        </button>
        {catalogue.apps.map((app) => (
          <button
            type="button"
            key={app.id}
            className={appId === app.id ? styles.appButtonActive : undefined}
            aria-current={appId === app.id ? "page" : undefined}
            onClick={() => {
              setAppId(app.id);
              setSelectedEntityId(null);
            }}
          >
            <strong>{app.label}</strong>
            <span>{countLabel(app.cubeCount, "cube")} · {countLabel(app.viewCount, "view")} · {countLabel(app.memberCount, "field")}</span>
            <small>{app.description}</small>
          </button>
        ))}
      </nav>

      <div className={styles.filters}>
        <label>
          <span className="sr-only">Search semantic objects and fields</span>
          <input
            type="search"
            placeholder="Search objects, fields, definitions or source paths…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          className={styles.explorerSelect}
          aria-label="Filter semantic object type"
          value={entityKind}
          onChange={(event) => {
            setEntityKind(event.target.value);
            setSelectedEntityId(null);
          }}
        >
          <option value="all">Cubes and views</option>
          <option value="view">Views only</option>
          <option value="cube">Cubes only</option>
        </select>
        <small>{filteredEntities.length} matching objects</small>
      </div>

      <div className={styles.explorerLayout}>
        <nav className={styles.entityList} aria-label="Semantic objects">
          {filteredEntities.map((entity) => (
            <button
              type="button"
              key={entity.id}
              aria-current={selectedEntity?.id === entity.id ? "true" : undefined}
              onClick={() => setSelectedEntityId(entity.id)}
            >
              <span className={styles.stateDot} data-state={entity.kind === "view" ? "verified" : "derived"} />
              <span>
                <strong>{entity.title}</strong>
                <small>{entity.name}</small>
              </span>
              <span>
                <em>{entity.kind}</em>
                <code>{entity.members.length}</code>
              </span>
            </button>
          ))}
          {!filteredEntities.length ? <p>No semantic objects match this filter.</p> : null}
        </nav>
        {selectedEntity ? (
          <ModelDefinition key={selectedEntity.id} entity={selectedEntity} rawFile={rawFile} />
        ) : (
          <div className={styles.inspectorEmpty}><p>Select an app or clear the search to inspect an object.</p></div>
        )}
      </div>

      <AgentKnowledge catalogue={catalogue} appId={appId} selectedEntity={selectedEntity} />
    </section>
  );
}
