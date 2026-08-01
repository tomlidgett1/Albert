"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./lab.module.css";

type DemoProps = {
  id: string;
  index: string;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
};

type TaskStatus = "Completed" | "Running" | "Draft";
type FilterStatus = "All" | "To do" | "In progress" | "Completed";

const thinkingModes = {
  Steps: ["Reading revenue data", "Comparing recent periods", "Checking connected systems"],
  Reasoning: ["Looking for the signal behind the change", "Separating seasonal lift from new demand", "Testing the conclusion against prior months"],
  Search: ["Searching sales history", "Checking invoice records", "Retrieving latest customer notes"],
  Coding: ["Writing the revenue query", "Normalising customer segments", "Preparing a reusable report"],
};

const taskRows: Array<{ title: string; detail: string; progress: string; status: TaskStatus }> = [
  { title: "Verify customer records", detail: "12 contacts", progress: "12 / 12", status: "Completed" },
  { title: "Build reorder brief", detail: "7 SKUs", progress: "68%", status: "Running" },
  { title: "Draft supplier notes", detail: "2 messages", progress: "Ready", status: "Draft" },
];

const contextChunks = [
  {
    type: "CRM",
    title: "Renewal conversation",
    detail: "284 characters",
    content: "Northwind expanded their reporting team and asked for a renewal proposal before the 14th.",
  },
  {
    type: "CSV",
    title: "Pipeline snapshot",
    detail: "1,104 rows",
    content: "Qualified pipeline is up 18% month-on-month, with the strongest movement in the mid-market segment.",
  },
];

const records = [
  { id: "northwind", initial: "N", company: "Northwind", tags: ["SaaS", "Enterprise"], updated: "2 hours ago", health: "Strong" },
  { id: "sunrise", initial: "S", company: "Sunrise Health", tags: ["Healthcare"], updated: "Yesterday", health: "Growing" },
  { id: "atlas", initial: "A", company: "Atlas Works", tags: ["Industrial", "Pilot"], updated: "4 days ago", health: "At risk" },
];

const filterTasks = [
  { name: "Review expansion forecast", date: "Today", status: "To do", owner: "Northwind" },
  { name: "Reconcile July invoices", date: "Aug 06", status: "In progress", owner: "Finance" },
  { name: "Draft renewal note", date: "Aug 09", status: "To do", owner: "Sunrise Health" },
  { name: "Clean product taxonomy", date: "Aug 12", status: "In progress", owner: "Atlas Works" },
  { name: "Send QBR follow-up", date: "Jul 29", status: "Completed", owner: "Northwind" },
];

const searchItems = [
  "Forecast next quarter revenue",
  "Find customers at renewal risk",
  "Compare new and expansion revenue",
  "Draft a board-ready growth summary",
  "Check overdue enterprise invoices",
];

const insights = [
  {
    label: "Revenue quality",
    summary: "Expansion is carrying more of this month’s growth than new business.",
    metric: "+18.4%",
    note: "vs. last month",
    bars: [42, 61, 56, 76, 70, 88],
  },
  {
    label: "Retention signal",
    summary: "Three accounts need attention before their next renewal milestone.",
    metric: "3 accounts",
    note: "need a follow-up",
    bars: [66, 55, 63, 44, 33, 29],
  },
  {
    label: "Pipeline velocity",
    summary: "Deals are progressing faster in the mid-market segment this week.",
    metric: "-2.1 days",
    note: "average cycle time",
    bars: [31, 37, 48, 56, 71, 82],
  },
];

function Demo({ id, index, title, description, children, wide = false }: DemoProps) {
  return (
    <section className={`${styles.demo} ${wide ? styles.demoWide : ""}`} id={id}>
      <header className={styles.demoHeader}>
        <span className={styles.demoIndex}>{index}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div className={styles.demoCanvas}>{children}</div>
    </section>
  );
}

function statusClass(status: TaskStatus) {
  if (status === "Completed") return styles.statusComplete;
  if (status === "Running") return styles.statusRunning;
  return styles.statusDraft;
}

export default function ComponentLabPage() {
  const [elapsed, setElapsed] = useState(0);
  const [loaderMode, setLoaderMode] = useState<"Drive" | "Dots" | "Orbit">("Drive");
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [thinkingMode, setThinkingMode] = useState<keyof typeof thinkingModes>("Steps");
  const [approvalStep, setApprovalStep] = useState(0);
  const [approvalAnswer, setApprovalAnswer] = useState("");
  const [approvalDismissed, setApprovalDismissed] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [taskLayout, setTaskLayout] = useState<"Capsules" | "List">("Capsules");
  const [chatTab, setChatTab] = useState<"Revenue" | "Customers">("Revenue");
  const [chatPrompt, setChatPrompt] = useState("");
  const [chatMessages, setChatMessages] = useState<string[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [recommendationAccepted, setRecommendationAccepted] = useState(false);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterStatus>("All");
  const [miniNav, setMiniNav] = useState("Overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [insightIndex, setInsightIndex] = useState(0);
  const [fineLayout, setFineLayout] = useState<"row" | "stack" | "grid">("row");
  const [fineRadius, setFineRadius] = useState(22);
  const [fineOpacity, setFineOpacity] = useState(100);

  useEffect(() => {
    const interval = window.setInterval(() => setElapsed((value) => value + 0.1), 100);
    return () => window.clearInterval(interval);
  }, []);

  const visibleSearchItems = useMemo(
    () => searchItems.filter((item) => item.toLowerCase().includes(searchQuery.toLowerCase())),
    [searchQuery],
  );

  const visibleTasks = useMemo(
    () => filter === "All" ? filterTasks : filterTasks.filter((task) => task.status === filter),
    [filter],
  );

  const insight = insights[insightIndex];
  const approvalChoices = ["Keep it concise", "Include context", "Write the full plan"];
  const approvalQuestion = [
    "How much detail should Albert include?",
    "Who is this analysis for?",
    "Should Albert prepare a next step?",
  ][approvalStep];

  const submitChat = () => {
    const prompt = chatPrompt.trim();
    if (!prompt) return;
    setChatMessages((messages) => [...messages, prompt]);
    setChatPrompt("");
  };

  const toggleRecord = (recordId: string) => {
    setSelectedRecords((selected) => (
      selected.includes(recordId)
        ? selected.filter((id) => id !== recordId)
        : [...selected, recordId]
    ));
  };

  return (
    <main className={styles.lab}>
      <header className={styles.labHeader}>
        <a className={styles.backLink} href="/dash">← Albert Dash</a>
        <div className={styles.headerCopy}>
          <p className={styles.eyebrow}>ALBERT COMPONENT LAB</p>
          <h1>Interfaces that show the work.</h1>
          <p>
            A local library of agent states, data surfaces, and quiet motion for Albert.
          </p>
        </div>
        <div className={styles.headerStats} aria-label="Component lab summary">
          <span><strong>17</strong> primitives</span>
          <span><strong>0</strong> dependencies added</span>
        </div>
      </header>

      <nav className={styles.jumpNav} aria-label="Component shortcuts">
        <a href="#loading-state">Agent states</a>
        <a href="#chat-composer">Conversation</a>
        <a href="#records-table">Data views</a>
        <a href="#fine-tune-card">Controls</a>
      </nav>

      <div className={styles.library}>
        <Demo
          id="loading-state"
          index="01"
          title="Loading state"
          description="A soft, legible progress signal with a live elapsed state."
        >
          <div className={styles.loaderPanel}>
            <div className={`${styles.loaderMark} ${styles[`loader${loaderMode}`]}`} aria-hidden="true">
              {Array.from({ length: 16 }).map((_, index) => <span key={index} />)}
            </div>
            <div className={styles.loaderCopy}>
              <strong>Mapping your connected data</strong>
              <span>{elapsed.toFixed(1)}s</span>
            </div>
            <div className={styles.segmented} aria-label="Loading motion">
              {(["Drive", "Dots", "Orbit"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  aria-pressed={loaderMode === mode}
                  className={loaderMode === mode ? styles.segmentedActive : ""}
                  onClick={() => setLoaderMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </Demo>

        <Demo
          id="thinking-state"
          index="02"
          title="Thinking trace"
          description="Expandable progress with calm, purposeful motion."
        >
          <div className={styles.thinkingPanel}>
            <button
              type="button"
              className={styles.thinkingTrigger}
              aria-expanded={thinkingOpen}
              onClick={() => setThinkingOpen((open) => !open)}
            >
              <span className={styles.spark} aria-hidden="true">✦</span>
              <span>
                <strong>Albert is thinking</strong>
                <small>{thinkingOpen ? "Show less" : "Show trace"}</small>
              </span>
              <span className={styles.disclosure} aria-hidden="true">⌄</span>
            </button>
            {thinkingOpen ? (
              <ol className={styles.traceList}>
                {thinkingModes[thinkingMode].map((step, index) => (
                  <li key={step} style={{ "--step": index } as CSSProperties}>
                    <span aria-hidden="true" />
                    {step}
                  </li>
                ))}
              </ol>
            ) : null}
            <div className={styles.compactTabs} role="tablist" aria-label="Thinking trace mode">
              {(Object.keys(thinkingModes) as Array<keyof typeof thinkingModes>).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  role="tab"
                  aria-selected={thinkingMode === mode}
                  className={thinkingMode === mode ? styles.compactTabActive : ""}
                  onClick={() => setThinkingMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </Demo>

        <Demo
          id="streaming-text"
          index="03"
          title="Streaming answer"
          description="A staged response that leaves the important details easy to scan."
          wide
        >
          <div className={styles.streamPanel}>
            <p className={styles.streamAnswer}>
              {"Revenue is up 18% month-on-month, led by expansion from existing customers. The strongest signal is in the mid-market segment, where sales cycles are closing faster than last quarter.".split(" ").map((word, index) => (
                <span key={`${word}-${index}`} style={{ "--word": index } as CSSProperties}>{word}&nbsp;</span>
              ))}
            </p>
            <div className={styles.actionRow}>
              <button type="button">Summarise</button>
              <button type="button">Make a chart</button>
              <button type="button">Create brief</button>
            </div>
            <div className={styles.sourceRow}>
              <span>3 sources</span>
              <a href="#records-table">Salesforce</a>
              <a href="#context-cards">Xero</a>
              <a href="#filter-table">HubSpot</a>
            </div>
            <div className={styles.followUpRow}>
              <span>Try asking</span>
              <button type="button">What changed in enterprise?</button>
              <button type="button">Show the accounts behind this</button>
            </div>
          </div>
        </Demo>

        <Demo
          id="approval-card"
          index="04"
          title="Approval card"
          description="A human checkpoint before an agent takes consequential action."
        >
          {approvalDismissed ? (
            <button className={styles.restoreCard} type="button" onClick={() => setApprovalDismissed(false)}>
              Restore approval step
            </button>
          ) : (
            <div className={styles.approvalCard}>
              <div className={styles.approvalHeading}>
                <span className={styles.approvalMark}>?</span>
                <div><small>NEEDS YOUR INPUT</small><strong>{approvalQuestion}</strong></div>
                <button type="button" onClick={() => setApprovalDismissed(true)} aria-label="Dismiss approval">×</button>
              </div>
              <div className={styles.choiceList}>
                {approvalChoices.map((choice) => (
                  <button
                    type="button"
                    key={choice}
                    className={approvalAnswer === choice ? styles.choiceActive : ""}
                    aria-pressed={approvalAnswer === choice}
                    onClick={() => setApprovalAnswer(choice)}
                  >
                    <span>{choice}</span><b>→</b>
                  </button>
                ))}
              </div>
              <input
                aria-label="Custom approval response"
                placeholder="Or write a custom direction…"
                value={approvalAnswer.startsWith("Custom:") ? approvalAnswer.slice(7) : ""}
                onChange={(event) => setApprovalAnswer(event.target.value ? `Custom:${event.target.value}` : "")}
              />
              <div className={styles.approvalFooter}>
                <button type="button" disabled={approvalStep === 0} onClick={() => setApprovalStep((step) => step - 1)}>Previous</button>
                <span aria-label={`Question ${approvalStep + 1} of 3`}>
                  {[0, 1, 2].map((step) => <i key={step} className={step === approvalStep ? styles.stepActive : ""} />)}
                </span>
                <button type="button" disabled={!approvalAnswer || approvalStep === 2} onClick={() => setApprovalStep((step) => step + 1)}>Next</button>
              </div>
            </div>
          )}
        </Demo>

        <Demo
          id="tool-chips"
          index="05"
          title="Tool chips"
          description="Execution detail that remains out of the way until you need it."
        >
          <div className={styles.toolsPanel}>
            <button type="button" className={styles.toolSummary} aria-expanded={toolsOpen} onClick={() => setToolsOpen((open) => !open)}>
              <span className={styles.toolPulse} aria-hidden="true" />
              <span><strong>4 actions</strong><small>{toolsOpen ? "Collapse activity" : "Expand activity"}</small></span>
              <b aria-hidden="true">⌄</b>
            </button>
            {toolsOpen ? (
              <div className={styles.toolList}>
                <span><i>Query</i> Connectors · Revenue ledger</span>
                <span><i>Read</i> CRM · Renewal notes</span>
                <span><i>Write</i> Brief · Q3 growth summary</span>
                <span><i>Done</i> 4 systems checked</span>
              </div>
            ) : null}
          </div>
        </Demo>

        <Demo
          id="task-rows"
          index="06"
          title="Agent tasks"
          description="Status rows that clearly show progress, outcome, and next work."
        >
          <div className={`${styles.taskPanel} ${taskLayout === "List" ? styles.taskListMode : ""}`}>
            <div className={styles.taskRows}>
              {taskRows.map((task, index) => (
                <button className={styles.taskRow} type="button" key={task.title}>
                  <span className={styles.taskNumber}>{index + 1}</span>
                  <span className={styles.taskCopy}><strong>{task.title}</strong><small>{task.detail}</small></span>
                  <span className={`${styles.taskStatus} ${statusClass(task.status)}`}>{task.status}</span>
                  <span className={styles.taskProgress}>{task.progress}</span>
                </button>
              ))}
            </div>
            <div className={styles.segmented} aria-label="Task row display">
              {(["Capsules", "List"] as const).map((layout) => (
                <button key={layout} type="button" aria-pressed={taskLayout === layout} className={taskLayout === layout ? styles.segmentedActive : ""} onClick={() => setTaskLayout(layout)}>{layout}</button>
              ))}
            </div>
          </div>
        </Demo>

        <Demo
          id="chat-composer"
          index="07"
          title="Chat workspace"
          description="A focused thread with useful trace context and a composed input."
          wide
        >
          <div className={styles.chatPanel}>
            <div className={styles.chatTabs} role="tablist" aria-label="Chat context">
              {(["Revenue", "Customers"] as const).map((tab) => (
                <button type="button" key={tab} role="tab" aria-selected={chatTab === tab} className={chatTab === tab ? styles.chatTabActive : ""} onClick={() => setChatTab(tab)}>{tab}</button>
              ))}
            </div>
            <div className={styles.chatTranscript}>
              <div className={styles.agentBubble}>
                <div className={styles.bubbleMeta}><span>Albert</span><small>{chatTab === "Revenue" ? "Revenue analysis" : "Customer analysis"}</small></div>
                <p>{chatTab === "Revenue" ? "Expansion revenue is ahead of plan. Northwind and Atlas account for 41% of the uplift." : "Three customers are nearing renewal. Northwind is the highest-value account that needs a follow-up."}</p>
                <div className={styles.bubbleTags}><span>Connected data</span><span>2 minutes</span></div>
              </div>
              {chatMessages.map((message) => <p className={styles.userBubble} key={message}>{message}</p>)}
            </div>
            <form className={styles.inlineComposer} onSubmit={(event) => { event.preventDefault(); submitChat(); }}>
              <input aria-label="Chat prompt" placeholder="Ask Albert a follow-up" value={chatPrompt} onChange={(event) => setChatPrompt(event.target.value)} />
              <button type="submit" aria-label="Send prompt" disabled={!chatPrompt.trim()}>↑</button>
            </form>
          </div>
        </Demo>

        <Demo
          id="recommendation-card"
          index="08"
          title="Recommendation"
          description="An agent suggestion with confidence, trade-offs, and a clear approval path."
        >
          <div className={styles.recommendationCard}>
            {recommendationAccepted ? (
              <div className={styles.acceptedState}><span>✓</span><strong>Brief added to your workspace</strong><small>Albert will prepare the follow-up next.</small></div>
            ) : (
              <>
                <div className={styles.recommendationHeader}><span>ALBERT SUGGESTS</span><b>High confidence</b></div>
                <h3>Prioritise Northwind&apos;s renewal brief.</h3>
                <p>The account is expanding and the renewal date is within two weeks. A short executive summary is the most useful next step.</p>
                {showAlternatives ? (
                  <div className={styles.alternatives}>
                    <button type="button">Compare all renewal accounts <small>Lower confidence</small></button>
                    <button type="button">Draft a generic renewal note <small>Needs review</small></button>
                  </div>
                ) : null}
                <div className={styles.recommendationActions}>
                  <button type="button" onClick={() => setShowAlternatives((open) => !open)}>Alternatives</button>
                  <button type="button" onClick={() => setRecommendationAccepted(true)}>Accept</button>
                </div>
              </>
            )}
          </div>
        </Demo>

        <Demo
          id="context-cards"
          index="09"
          title="Context cards"
          description="Retrieved evidence that stays attached to the answer it informed."
        >
          <div className={styles.contextList}>
            {contextChunks.map((chunk) => (
              <article className={styles.contextCard} key={chunk.title}>
                <div><span>{chunk.type}</span><small>{chunk.detail}</small></div>
                <strong>{chunk.title}</strong>
                <p>{chunk.content}</p>
              </article>
            ))}
          </div>
        </Demo>

        <Demo
          id="diff-table"
          index="10"
          title="Diff table"
          description="A safe, side-by-side surface for proposed agent changes."
          wide
        >
          <div className={styles.tableShell}>
            <div className={styles.tableTitle}><span>PROPOSED CHANGES</span><strong>Customer taxonomy cleanup</strong></div>
            <table className={styles.diffTable}>
              <thead><tr><th>Customer</th><th>Current segment</th><th>Proposed segment</th><th>Reason</th></tr></thead>
              <tbody>
                <tr><td>Northwind</td><td><span className={styles.tagMuted}>Enterprise</span></td><td><span className={styles.tagAdded}>Strategic</span></td><td>Expansion signal</td></tr>
                <tr><td>Sunrise Health</td><td><span className={styles.tagMuted}>Growth</span></td><td><span className={styles.tagAdded}>Enterprise</span></td><td>Annual spend</td></tr>
                <tr><td>Atlas Works</td><td><span className={styles.tagRemoved}>Pilot</span></td><td><span className={styles.tagAdded}>Growth</span></td><td>Active rollout</td></tr>
              </tbody>
            </table>
          </div>
        </Demo>

        <Demo
          id="records-table"
          index="11"
          title="Records table"
          description="Dense account data with selection, context, and relationship health."
          wide
        >
          <div className={styles.tableShell}>
            <div className={styles.tableTitle}><span>CONNECTED CRM</span><strong>{selectedRecords.length ? `${selectedRecords.length} selected` : "Accounts"}</strong></div>
            <div className={styles.recordScroller}>
              <table className={styles.recordsTable}>
                <thead><tr><th aria-label="Select" /><th>Company</th><th>Categories</th><th>Last interaction</th><th>Relationship</th></tr></thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id} className={selectedRecords.includes(record.id) ? styles.recordSelected : ""}>
                      <td><input type="checkbox" aria-label={`Select ${record.company}`} checked={selectedRecords.includes(record.id)} onChange={() => toggleRecord(record.id)} /></td>
                      <td><span className={styles.recordAvatar}>{record.initial}</span><strong>{record.company}</strong></td>
                      <td><span className={styles.recordTags}>{record.tags.map((tag) => <i key={tag}>{tag}</i>)}</span></td>
                      <td>{record.updated}</td>
                      <td><span className={styles.health}>{record.health}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Demo>

        <Demo
          id="filter-table"
          index="12"
          title="Filter table"
          description="Status controls that reorganise a live working set."
          wide
        >
          <div className={styles.filterPanel}>
            <div className={styles.filterTabs} role="tablist" aria-label="Task status filter">
              {(["All", "To do", "In progress", "Completed"] as FilterStatus[]).map((status) => (
                <button type="button" role="tab" key={status} aria-selected={filter === status} className={filter === status ? styles.filterActive : ""} onClick={() => setFilter(status)}>
                  {status}<small>{status === "All" ? filterTasks.length : filterTasks.filter((task) => task.status === status).length}</small>
                </button>
              ))}
            </div>
            <div className={styles.filterTable}>
              <div className={styles.filterHead}><span>Task</span><span>Date</span><span>Status</span><span>Owner</span></div>
              {visibleTasks.map((task) => <div className={styles.filterRow} key={task.name}><strong>{task.name}</strong><span>{task.date}</span><span className={styles[`filter${task.status.replaceAll(" ", "")}`]}>{task.status}</span><span>{task.owner}</span></div>)}
            </div>
          </div>
        </Demo>

        <Demo
          id="sidebar-nav"
          index="13"
          title="Sidebar nav"
          description="A compact workspace navigator with just enough hierarchy."
        >
          <div className={styles.miniSidebar}>
            <div className={styles.miniWorkspace}><span>A</span><div><strong>Albert workspace</strong><small>Analytics team</small></div></div>
            <input aria-label="Quick search" placeholder="Quick search" />
            <button type="button" className={styles.newTask}>+ New task</button>
            <p>WORKSPACE</p>
            {["Overview", "Agent tasks", "Inbox", "Customers", "Connectors"].map((item) => (
              <button type="button" key={item} className={miniNav === item ? styles.miniNavActive : ""} onClick={() => setMiniNav(item)}><span>{item === "Agent tasks" ? "4" : ""}</span>{item}</button>
            ))}
          </div>
        </Demo>

        <Demo
          id="search"
          index="14"
          title="Command search"
          description="Fast filtering with clear next actions and an honest empty state."
        >
          <div className={styles.commandPanel}>
            <label className={styles.commandInput}><span aria-hidden="true">⌕</span><input aria-label="Search actions" placeholder="Search actions" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /><kbd>⌘ K</kbd></label>
            <div className={styles.commandResults}>
              {visibleSearchItems.length ? visibleSearchItems.map((item) => <button type="button" key={item}><span>{item}</span><small>↵</small></button>) : <p>No matching actions. Try a shorter search.</p>}
            </div>
          </div>
        </Demo>

        <Demo
          id="insight-cards"
          index="15"
          title="Insight cards"
          description="A concise observation with direct controls for moving through a set."
        >
          <div className={styles.insightCard}>
            <div className={styles.insightTop}><span>INSIGHT {insightIndex + 1} / {insights.length}</span><div><button type="button" aria-label="Previous insight" onClick={() => setInsightIndex((index) => (index + insights.length - 1) % insights.length)}>←</button><button type="button" aria-label="Next insight" onClick={() => setInsightIndex((index) => (index + 1) % insights.length)}>→</button></div></div>
            <h3>{insight.label}</h3>
            <p>{insight.summary}</p>
            <div className={styles.insightMetric}><strong>{insight.metric}</strong><span>{insight.note}</span></div>
            <div className={styles.barChart} aria-label="Illustrative trend chart">
              {insight.bars.map((height, index) => <i key={index} style={{ "--height": `${height}%`, "--bar": index } as CSSProperties} />)}
            </div>
          </div>
        </Demo>

        <Demo
          id="code-block"
          index="16"
          title="Code stream"
          description="A clean surface for an agent-generated query or reusable snippet."
        >
          <div className={styles.codeBlock}>
            <div><span>revenue-brief.ts</span><small>ALBERT GENERATED</small></div>
            {["const report = await albert.analyse({", "  sources: [\"xero\", \"hubspot\"],", "  question: \"What changed this month?\",", "});", "", "return report.withNextSteps();"].map((line, index) => (
              <p key={`${line}-${index}`} style={{ "--line": index } as CSSProperties}><i>{index + 1}</i><code>{line || " "}</code></p>
            ))}
          </div>
        </Demo>

        <Demo
          id="fine-tune-card"
          index="17"
          title="Fine-tune card"
          description="Direct controls for adjusting an agent-built interface without leaving the work."
          wide
        >
          <div className={styles.inspector}>
            <div className={styles.inspectorPreview}>
              <div className={`${styles.tunedCard} ${styles[`layout${fineLayout[0].toUpperCase()}${fineLayout.slice(1)}`]}`} style={{ "--tuned-radius": `${fineRadius}px`, "--tuned-opacity": fineOpacity / 100 } as CSSProperties}>
                <span className={styles.tunedAvatar}>A</span>
                <div><strong>Northwind growth brief</strong><small>Updated just now</small></div>
                <b>+18%</b>
              </div>
            </div>
            <div className={styles.inspectorControls}>
              <div className={styles.inspectorTitle}><span>FINE-TUNE</span><strong>Customer card</strong></div>
              <div className={styles.layoutButtons} aria-label="Card layout">
                {(["row", "stack", "grid"] as const).map((layout) => <button type="button" key={layout} aria-pressed={fineLayout === layout} className={fineLayout === layout ? styles.layoutActive : ""} onClick={() => setFineLayout(layout)}>{layout}</button>)}
              </div>
              <label>Corner radius <output>{fineRadius}px</output><input type="range" min="8" max="32" value={fineRadius} onChange={(event) => setFineRadius(Number(event.target.value))} /></label>
              <label>Opacity <output>{fineOpacity}%</output><input type="range" min="45" max="100" value={fineOpacity} onChange={(event) => setFineOpacity(Number(event.target.value))} /></label>
            </div>
          </div>
        </Demo>
      </div>
    </main>
  );
}
