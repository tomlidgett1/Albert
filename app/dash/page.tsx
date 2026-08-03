"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type SVGProps } from "react";
import { AnimatePresence, animate, motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  DEFAULT_AGENT_PREFERENCES,
  type AgentRunPreferences,
  type TraceEvent,
} from "@/packages/shared/src";
import { createClient } from "@/utils/supabase/client";
import AnalyticalTrace from "./components/AnalyticalTrace";
import ConnectionsWorkspace from "./components/ConnectionsWorkspace";
import { ModelRunControls } from "./components/ModelRunControls";
import styles from "./dash.module.css";

type IconName =
  | "search"
  | "panel"
  | "monitor"
  | "sun"
  | "moon"
  | "home"
  | "chat"
  | "agents"
  | "connections"
  | "audio"
  | "mic"
  | "images"
  | "codex"
  | "key"
  | "usage"
  | "logs"
  | "batches"
  | "storage"
  | "plugins"
  | "settings"
  | "more"
  | "organization"
  | "profile"
  | "docs"
  | "terms"
  | "help"
  | "logout"
  | "chevron"
  | "chevrons"
  | "plus"
  | "arrowUp"
  | "arrowUpRight"
  | "sparkle"
  | "close";

type NavItem = {
  label: string;
  icon: IconName;
};

const navItems: NavItem[] = [
  { label: "Dashboard", icon: "home" },
  { label: "Chat", icon: "chat" },
  { label: "Agents", icon: "agents" },
  { label: "Connections", icon: "connections" },
];

const pageTabs: Record<string, string[]> = {
  Chat: ["Playground", "Agent"],
  Agents: ["Overview", "Runs"],
  Connections: ["Connected apps"],
};

const dashboards = [
  {
    id: "overview",
    label: "Overview",
    title: "Business overview",
    description: "A live view of how the business is tracking today.",
    metrics: [
      { label: "Revenue", value: "$48.2k", delta: "+8.4%" },
      { label: "Orders", value: "312", delta: "+12%" },
      { label: "Active agents", value: "4", delta: "Stable" },
      { label: "Open tasks", value: "19", delta: "-3" },
    ],
    table: {
      title: "Recent activity",
      columns: ["Source", "Event", "Value", "Status"],
      rows: [
        ["Lightspeed", "Sale · Bondi", "$184.00", "Synced"],
        ["Xero", "Invoice paid", "$2,400.00", "Cleared"],
        ["Albert", "Agent run", "Weekly summary", "Complete"],
        ["Lightspeed", "Refund · Online", "-$42.00", "Review"],
        ["Xero", "Bill due", "$860.00", "Pending"],
      ],
    },
    barChart: {
      title: "Orders by channel",
      series: [
        { label: "Store", value: 118 },
        { label: "Online", value: 94 },
        { label: "Phone", value: 41 },
        { label: "Wholesale", value: 59 },
      ],
    },
    lineChart: {
      title: "Revenue trend",
      series: [
        { label: "Mon", value: 42 },
        { label: "Tue", value: 48 },
        { label: "Wed", value: 39 },
        { label: "Thu", value: 55 },
        { label: "Fri", value: 61 },
        { label: "Sat", value: 72 },
        { label: "Sun", value: 58 },
      ],
    },
  },
  {
    id: "sales",
    label: "Sales",
    title: "Sales performance",
    description: "Track store sales, conversion, and standout products.",
    metrics: [
      { label: "Sales today", value: "$6.4k", delta: "+14%" },
      { label: "Avg. order", value: "$84", delta: "+$6" },
      { label: "Conversion", value: "3.2%", delta: "+0.4%" },
      { label: "Units sold", value: "761", delta: "+9%" },
    ],
    table: {
      title: "Top products",
      columns: ["Product", "Channel", "Units", "Revenue"],
      rows: [
        ["Coastal Tee", "Store", "86", "$2,150"],
        ["Harbour Cap", "Online", "64", "$1,280"],
        ["Weekend Bag", "Store", "22", "$1,980"],
        ["Daily Socks", "Online", "140", "$980"],
        ["Trail Jacket", "Wholesale", "18", "$2,340"],
      ],
    },
    barChart: {
      title: "Sales by store",
      series: [
        { label: "Bondi", value: 86 },
        { label: "Surry", value: 72 },
        { label: "Newtown", value: 54 },
        { label: "Online", value: 91 },
      ],
    },
    lineChart: {
      title: "Daily sales",
      series: [
        { label: "Mon", value: 38 },
        { label: "Tue", value: 44 },
        { label: "Wed", value: 51 },
        { label: "Thu", value: 47 },
        { label: "Fri", value: 68 },
        { label: "Sat", value: 84 },
        { label: "Sun", value: 63 },
      ],
    },
  },
  {
    id: "customers",
    label: "Customers",
    title: "Customer activity",
    description: "See who is engaging, returning, and needing a follow-up.",
    metrics: [
      { label: "New customers", value: "48", delta: "+11" },
      { label: "Returning", value: "61%", delta: "+2%" },
      { label: "Open tickets", value: "7", delta: "-2" },
      { label: "NPS", value: "54", delta: "+3" },
    ],
    table: {
      title: "Customer queue",
      columns: ["Customer", "Touchpoint", "Value", "Priority"],
      rows: [
        ["A. Nguyen", "Support", "Order delay", "High"],
        ["J. Patel", "Email", "Restock alert", "Medium"],
        ["S. Clarke", "In store", "Loyalty join", "Low"],
        ["M. Rossi", "Chat", "Refund request", "High"],
        ["L. Brown", "Email", "Quote follow-up", "Medium"],
      ],
    },
    barChart: {
      title: "Visits by segment",
      series: [
        { label: "New", value: 48 },
        { label: "Loyal", value: 76 },
        { label: "At risk", value: 23 },
        { label: "VIP", value: 31 },
      ],
    },
    lineChart: {
      title: "Engagement trend",
      series: [
        { label: "Mon", value: 28 },
        { label: "Tue", value: 34 },
        { label: "Wed", value: 31 },
        { label: "Thu", value: 42 },
        { label: "Fri", value: 49 },
        { label: "Sat", value: 57 },
        { label: "Sun", value: 45 },
      ],
    },
  },
  {
    id: "finance",
    label: "Finance",
    title: "Cash and invoices",
    description: "Keep cash flow, invoices, and outstanding balances in view.",
    metrics: [
      { label: "Cash on hand", value: "$126k", delta: "+$4.2k" },
      { label: "Invoices due", value: "$18.4k", delta: "-$1.1k" },
      { label: "Paid this week", value: "$9.1k", delta: "+18%" },
      { label: "Burn rate", value: "$22k", delta: "Stable" },
    ],
    table: {
      title: "Invoice register",
      columns: ["Invoice", "Counterparty", "Amount", "Status"],
      rows: [
        ["INV-2041", "Northside Co", "$3,200", "Paid"],
        ["INV-2042", "Harbour Labs", "$1,850", "Due"],
        ["BILL-881", "Supply Hub", "$860", "Scheduled"],
        ["INV-2043", "Coast Retail", "$4,100", "Overdue"],
        ["BILL-882", "Studio Rent", "$2,400", "Paid"],
      ],
    },
    barChart: {
      title: "Cash by category",
      series: [
        { label: "Sales", value: 92 },
        { label: "Invoices", value: 64 },
        { label: "Costs", value: 48 },
        { label: "Tax", value: 27 },
      ],
    },
    lineChart: {
      title: "Cash flow",
      series: [
        { label: "Mon", value: 52 },
        { label: "Tue", value: 49 },
        { label: "Wed", value: 58 },
        { label: "Thu", value: 61 },
        { label: "Fri", value: 55 },
        { label: "Sat", value: 67 },
        { label: "Sun", value: 70 },
      ],
    },
  },
] as const;

type DashboardChartPoint = { label: string; value: number };

type DashboardView = {
  id: string;
  label: string;
  title: string;
  description: string;
  metrics: ReadonlyArray<{ label: string; value: string; delta: string }>;
  table: {
    title: string;
    columns: readonly string[];
    rows: ReadonlyArray<readonly string[]>;
  };
  barChart: {
    title: string;
    series: ReadonlyArray<DashboardChartPoint>;
  };
  lineChart: {
    title: string;
    series: ReadonlyArray<DashboardChartPoint>;
  };
};

const starterDashboards: DashboardView[] = dashboards.map((dashboard) => ({
  id: dashboard.id,
  label: dashboard.label,
  title: dashboard.title,
  description: dashboard.description,
  metrics: [...dashboard.metrics],
  table: {
    title: dashboard.table.title,
    columns: [...dashboard.table.columns],
    rows: dashboard.table.rows.map((row) => [...row]),
  },
  barChart: {
    title: dashboard.barChart.title,
    series: [...dashboard.barChart.series],
  },
  lineChart: {
    title: dashboard.lineChart.title,
    series: [...dashboard.lineChart.series],
  },
}));

function createBlankDashboard(index: number): DashboardView {
  return {
    id: `dashboard-${Date.now()}-${index}`,
    label: `Dashboard ${index}`,
    title: "New dashboard",
    description: "Start adding metrics, tables, and charts to this canvas.",
    metrics: [
      { label: "Metric 1", value: "—", delta: "—" },
      { label: "Metric 2", value: "—", delta: "—" },
      { label: "Metric 3", value: "—", delta: "—" },
      { label: "Metric 4", value: "—", delta: "—" },
    ],
    table: {
      title: "Raw data",
      columns: ["Column A", "Column B", "Column C", "Column D"],
      rows: [
        ["—", "—", "—", "—"],
        ["—", "—", "—", "—"],
        ["—", "—", "—", "—"],
      ],
    },
    barChart: {
      title: "Bar chart",
      series: [
        { label: "A", value: 24 },
        { label: "B", value: 40 },
        { label: "C", value: 32 },
        { label: "D", value: 18 },
      ],
    },
    lineChart: {
      title: "Line graph",
      series: [
        { label: "Mon", value: 20 },
        { label: "Tue", value: 28 },
        { label: "Wed", value: 24 },
        { label: "Thu", value: 36 },
        { label: "Fri", value: 42 },
        { label: "Sat", value: 38 },
        { label: "Sun", value: 45 },
      ],
    },
  };
}

const agentScheduleFrequencies = ["Manual", "Hourly", "Daily", "Weekly"] as const;
type AgentScheduleFrequency = (typeof agentScheduleFrequencies)[number];

const agentScheduleTimes = ["06:00", "09:00", "12:00", "17:00", "21:00"];
const agentScheduleDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const recentConversations = [
  { title: "Lightspeed connection setup", meta: "Today · 3 messages" },
  { title: "Weekly sales summary", meta: "Yesterday · 8 messages" },
  { title: "Prepare a customer follow-up", meta: "Monday · 5 messages" },
  { title: "Q3 planning notes", meta: "July 28 · 12 messages" },
];

const timeRanges = ["24h", "7d", "30d", "90d"];

type ConnectionId = "lightspeed" | "xero" | "deputy";

const connectionProviders: Array<{
  id: ConnectionId;
  name: string;
  description: string;
  logo: string;
}> = [
  {
    id: "lightspeed",
    name: "Lightspeed",
    description: "Sync sales, inventory, and store activity.",
    logo: "/logos/lightspeed.png",
  },
  {
    id: "xero",
    name: "Xero",
    description: "Bring in invoices, payments, and accounting data.",
    logo: "/logos/xero.svg",
  },
  {
    id: "deputy",
    name: "Deputy",
    description: "Sync rosters, timesheets, and workforce data.",
    logo: "/logos/deputy.png",
  },
];

type AgentStatus = "Active" | "Paused" | "Draft";

type AgentRun = {
  id: string;
  at: string;
  result: string;
  duration: string;
};

type ExampleAgent = {
  id: string;
  name: string;
  status: AgentStatus;
  schedule: string;
  lastRun: string;
  nextRun: string;
  tools: string[];
  prompt: string;
  runs: AgentRun[];
};

const exampleAgents: ExampleAgent[] = [
  {
    id: "weekly-sales",
    name: "Weekly sales briefing",
    status: "Active",
    schedule: "Weekly · Mon 09:00",
    lastRun: "2 hours ago",
    nextRun: "Mon 09:00",
    tools: ["Lightspeed", "Xero"],
    prompt: "Summarise last week's sales by store and channel. Flag anything unusual and draft three follow-up actions for the team.",
    runs: [
      { id: "r1", at: "Today · 09:00", result: "Complete", duration: "42s" },
      { id: "r2", at: "25 Jul · 09:00", result: "Complete", duration: "38s" },
      { id: "r3", at: "18 Jul · 09:00", result: "Complete", duration: "51s" },
    ],
  },
  {
    id: "low-stock",
    name: "Low stock watcher",
    status: "Active",
    schedule: "Daily · 07:00",
    lastRun: "5 hours ago",
    nextRun: "Tomorrow 07:00",
    tools: ["Lightspeed"],
    prompt: "Check inventory across all stores. List SKUs under two weeks of cover and suggest reorder quantities.",
    runs: [
      { id: "r1", at: "Today · 07:00", result: "Complete", duration: "27s" },
      { id: "r2", at: "1 Aug · 07:00", result: "Complete", duration: "24s" },
      { id: "r3", at: "31 Jul · 07:00", result: "Warning", duration: "33s" },
    ],
  },
  {
    id: "invoice-chase",
    name: "Overdue invoice chase",
    status: "Active",
    schedule: "Daily · 10:00",
    lastRun: "Yesterday",
    nextRun: "Tomorrow 10:00",
    tools: ["Xero"],
    prompt: "Find invoices overdue by more than 14 days. Draft polite reminder emails grouped by customer.",
    runs: [
      { id: "r1", at: "Yesterday · 10:00", result: "Complete", duration: "36s" },
      { id: "r2", at: "31 Jul · 10:00", result: "Complete", duration: "41s" },
      { id: "r3", at: "30 Jul · 10:00", result: "Complete", duration: "29s" },
    ],
  },
  {
    id: "cashflow",
    name: "Cashflow snapshot",
    status: "Paused",
    schedule: "Weekly · Fri 16:00",
    lastRun: "4 days ago",
    nextRun: "Paused",
    tools: ["Xero"],
    prompt: "Produce a Friday cashflow snapshot with expected inflows, outflows, and a short risk note for next week.",
    runs: [
      { id: "r1", at: "29 Jul · 16:00", result: "Complete", duration: "47s" },
      { id: "r2", at: "22 Jul · 16:00", result: "Complete", duration: "44s" },
      { id: "r3", at: "15 Jul · 16:00", result: "Failed", duration: "12s" },
    ],
  },
  {
    id: "morning-brief",
    name: "Morning ops brief",
    status: "Active",
    schedule: "Daily · 06:30",
    lastRun: "6 hours ago",
    nextRun: "Tomorrow 06:30",
    tools: ["Lightspeed", "Xero"],
    prompt: "Build a short morning brief covering overnight sales, open tasks, and anything that needs attention before open.",
    runs: [
      { id: "r1", at: "Today · 06:30", result: "Complete", duration: "31s" },
      { id: "r2", at: "1 Aug · 06:30", result: "Complete", duration: "28s" },
      { id: "r3", at: "31 Jul · 06:30", result: "Complete", duration: "35s" },
    ],
  },
  {
    id: "refund-review",
    name: "Refund review",
    status: "Active",
    schedule: "Daily · 18:00",
    lastRun: "20 hours ago",
    nextRun: "Today 18:00",
    tools: ["Lightspeed"],
    prompt: "Review refunds from the last 24 hours. Highlight high-value or repeat cases and recommend next steps.",
    runs: [
      { id: "r1", at: "Yesterday · 18:00", result: "Complete", duration: "22s" },
      { id: "r2", at: "31 Jul · 18:00", result: "Complete", duration: "19s" },
      { id: "r3", at: "30 Jul · 18:00", result: "Complete", duration: "26s" },
    ],
  },
  {
    id: "staff-roster",
    name: "Roster reminder",
    status: "Draft",
    schedule: "Weekly · Thu 12:00",
    lastRun: "Never",
    nextRun: "Not scheduled",
    tools: ["Lightspeed"],
    prompt: "Remind managers about next week's roster gaps and list shifts that still need coverage.",
    runs: [],
  },
  {
    id: "margin-check",
    name: "Margin anomaly check",
    status: "Active",
    schedule: "Hourly",
    lastRun: "48 min ago",
    nextRun: "In 12 min",
    tools: ["Lightspeed", "Xero"],
    prompt: "Scan recent sales for margin anomalies versus category averages and call out products that need a pricing review.",
    runs: [
      { id: "r1", at: "Today · 10:00", result: "Complete", duration: "18s" },
      { id: "r2", at: "Today · 09:00", result: "Complete", duration: "17s" },
      { id: "r3", at: "Today · 08:00", result: "Complete", duration: "21s" },
    ],
  },
  {
    id: "customer-followup",
    name: "VIP follow-up drafts",
    status: "Paused",
    schedule: "Daily · 11:00",
    lastRun: "3 days ago",
    nextRun: "Paused",
    tools: ["Lightspeed"],
    prompt: "Draft personalised follow-ups for VIP customers who purchased in the last week but have not been contacted.",
    runs: [
      { id: "r1", at: "30 Jul · 11:00", result: "Complete", duration: "55s" },
      { id: "r2", at: "29 Jul · 11:00", result: "Complete", duration: "49s" },
      { id: "r3", at: "28 Jul · 11:00", result: "Warning", duration: "61s" },
    ],
  },
  {
    id: "month-end",
    name: "Month-end pack",
    status: "Draft",
    schedule: "Manual",
    lastRun: "Never",
    nextRun: "Manual only",
    tools: ["Xero", "Lightspeed"],
    prompt: "Assemble a month-end pack with revenue, costs, top products, and a one-page narrative for leadership.",
    runs: [],
  },
];

type Theme = "system" | "light" | "dark";

const themeOptions: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: "system", label: "System theme", icon: "monitor" },
  { value: "light", label: "Light theme", icon: "sun" },
  { value: "dark", label: "Dark theme", icon: "moon" },
];

const themeStorageKey = "albert-theme";

const themeListeners = new Set<() => void>();
let themeSnapshot: Theme = "system";

function isTheme(value: string | null): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function getThemeSnapshot(): Theme {
  if (typeof window === "undefined") return themeSnapshot;

  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    if (isTheme(storedTheme)) themeSnapshot = storedTheme;
  } catch {
    // The in-memory preference remains available when browser storage is blocked.
  }

  return themeSnapshot;
}

function getServerThemeSnapshot(): Theme {
  return "system";
}

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  const handleStorageChange = () => listener();
  window.addEventListener("storage", handleStorageChange);

  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", handleStorageChange);
  };
}

function setThemePreference(nextTheme: Theme) {
  themeSnapshot = nextTheme;

  try {
    window.localStorage.setItem(themeStorageKey, nextTheme);
  } catch {
    // The in-memory preference remains available when browser storage is blocked.
  }

  themeListeners.forEach((listener) => listener());
}

function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const shared = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.9,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    ...props,
  };

  switch (name) {
    case "search":
      return <svg {...shared}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>;
    case "panel":
      return <svg {...shared}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M12 4v16" /></svg>;
    case "monitor":
      return <svg {...shared}><rect x="3.5" y="5" width="17" height="11.5" rx="1.8" /><path d="M9 20h6M12 16.5V20" /></svg>;
    case "sun":
      return <svg {...shared}><circle cx="12" cy="12" r="3.5" /><path d="M12 2.8v2M12 19.2v2M21.2 12h-2M4.8 12h-2M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4M18.5 18.5l-1.4-1.4M6.9 6.9 5.5 5.5" /></svg>;
    case "moon":
      return <svg {...shared}><path d="M19.7 14.5A7.8 7.8 0 0 1 9.5 4.3a8 8 0 1 0 10.2 10.2Z" /></svg>;
    case "home":
      return <svg {...shared}><path d="m3.5 10.8 8.5-7 8.5 7" /><path d="M5.3 9.8v9.1a1.5 1.5 0 0 0 1.5 1.5h10.4a1.5 1.5 0 0 0 1.5-1.5V9.8" /><path d="M9.2 20.4v-5.8h5.6v5.8" /></svg>;
    case "chat":
      return <svg {...shared}><path d="M20.2 11.2c0 4.5-3.7 8.1-8.3 8.1a8.8 8.8 0 0 1-3.2-.6l-4.7 1.2 1.2-4.3a7.8 7.8 0 0 1-1.5-4.4c0-4.5 3.7-8.1 8.2-8.1s8.3 3.6 8.3 8.1Z" /></svg>;
    case "agents":
      return <svg {...shared}><path d="M12 3.5 13.5 9l5.5 1.5-5.5 1.5-1.5 5.5-1.5-5.5L5 10.5 10.5 9 12 3.5Z" /><path d="m18.2 15.5.6 2.1 2.1.6-2.1.6-.6 2.1-.6-2.1-2.1-.6 2.1-.6.6-2.1Z" /></svg>;
    case "connections":
      return <svg {...shared}><path d="M9.2 14.8 7.6 16.4a3.2 3.2 0 0 1-4.5-4.5l3.3-3.3a3.2 3.2 0 0 1 4.5 0" /><path d="m14.8 9.2 1.6-1.6a3.2 3.2 0 0 1 4.5 4.5l-3.3 3.3a3.2 3.2 0 0 1-4.5 0" /><path d="m8.5 15.5 7-7" /></svg>;
    case "audio":
      return <svg {...shared}><path d="M6 10v4" /><path d="M10 6.5v11" /><path d="M14 9v6" /><path d="M18 7v10" /></svg>;
    case "mic":
      return <svg {...shared}><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6" /></svg>;
    case "images":
      return <svg {...shared}><rect x="3.5" y="4" width="17" height="16" rx="2" /><circle cx="9" cy="9" r="1.6" /><path d="m4.5 17 4.3-4.1a1.6 1.6 0 0 1 2.2 0l2.1 2 1.8-1.6a1.6 1.6 0 0 1 2.2 0l2.4 2.3" /></svg>;
    case "codex":
      return <svg {...shared}><path d="M7.1 8.1a4.4 4.4 0 0 1 8.1-1.2 4.1 4.1 0 0 1 2.5 7.4 4.3 4.3 0 0 1-7.4 2.9 4.2 4.2 0 0 1-5.8-5.9 4.1 4.1 0 0 1 2.6-3.2Z" /><path d="m12 8.3.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z" /></svg>;
    case "key":
      return <svg {...shared}><circle cx="8.5" cy="15.5" r="3.6" /><path d="m11.2 12.8 7.5-7.5 2.2 2.2-1.7 1.7 1.2 1.2-1.8 1.8-1.2-1.2-2.7 2.7" /></svg>;
    case "usage":
      return <svg {...shared}><path d="m3.5 17 5.1-5.1 3.4 2.6 7.8-8" /><path d="M15.4 6.5h4.4v4.4" /></svg>;
    case "logs":
      return <svg {...shared}><path d="m5 7 2-2h10l2 2" /><path d="m5 12 2-2h10l2 2" /><path d="m5 17 2-2h10l2 2" /></svg>;
    case "batches":
      return <svg {...shared}><path d="M8.3 4.2H6.5a2 2 0 0 0-2 2v2.1a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2.1a2 2 0 0 0 2 2h1.8" /><path d="M15.7 4.2h1.8a2 2 0 0 1 2 2v2.1a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2.1a2 2 0 0 1-2 2h-1.8" /><path d="M9 8.5h6M9 12h6M9 15.5h6" /></svg>;
    case "storage":
      return <svg {...shared}><ellipse cx="12" cy="5.7" rx="7" ry="2.8" /><path d="M5 5.7v6.3c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V5.7" /><path d="M5 12v6.3c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V12" /></svg>;
    case "plugins":
      return <svg {...shared}><circle cx="12" cy="12" r="8.6" /><path d="M9.2 9.2 14.8 8l-1.2 5.6-5.6 1.2 1.2-5.6Z" /><path d="m15.8 8.2 1.4-1.4" /></svg>;
    case "settings":
      return <svg {...shared}><path d="m9.6 4.1.7-1.3h3.4l.7 1.3 1.6.9 1.4-.2 1.7 3-1 1.1.1 1.9 1 1.1-1.7 3-1.4-.2-1.6.9-.7 1.3h-3.4l-.7-1.3-1.6-.9-1.4.2-1.7-3 1-1.1-.1-1.9-1-1.1 1.7-3 1.4.2 1.6-.9Z" /><circle cx="12" cy="11.1" r="2.6" /></svg>;
    case "more":
      return <svg {...shared}><circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" /></svg>;
    case "organization":
      return <svg {...shared}><path d="M4 20V8.5l5-3v14.5M9 20h11M15 20V4h5v16" /><path d="M6.5 11h.1M6.5 14.5h.1M17.5 8h.1M17.5 11.5h.1M17.5 15h.1" /></svg>;
    case "profile":
      return <svg {...shared}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="9.5" r="2.6" /><path d="M7.5 17.3a5.5 5.5 0 0 1 9 0" /></svg>;
    case "docs":
      return <svg {...shared}><path d="M6.2 4.2h8.1l3.5 3.5v12.1H6.2z" /><path d="M14.3 4.2v4h3.5M8.8 12h6.4M8.8 15.5h4.7" /></svg>;
    case "terms":
      return <svg {...shared}><path d="M7 3.8h8.7l2.4 2.4v14H7z" /><path d="M15.7 3.8v3h2.4M9.5 11h6M9.5 14.5h6M9.5 18h3.2" /></svg>;
    case "help":
      return <svg {...shared}><circle cx="12" cy="12" r="8.5" /><path d="M8.9 9.2a3.2 3.2 0 0 1 6.1 1.4c0 2-2.7 2.2-2.7 3.8M12.3 17.2v.1" /></svg>;
    case "logout":
      return <svg {...shared}><path d="M10 4.2H6.2a2 2 0 0 0-2 2v11.6a2 2 0 0 0 2 2H10" /><path d="M13 8.2 17 12l-4 3.8M17 12H8.3" /></svg>;
    case "chevron":
      return <svg {...shared}><path d="m9 5 7 7-7 7" /></svg>;
    case "chevrons":
      return <svg {...shared}><path d="m7.5 9 4.5-4 4.5 4" /><path d="m7.5 15 4.5 4 4.5-4" /></svg>;
    case "plus":
      return <svg {...shared}><path d="M12 5v14M5 12h14" /></svg>;
    case "arrowUp":
      return <svg {...shared}><path d="M12 18V6M7.5 10.5 12 6l4.5 4.5" /></svg>;
    case "arrowUpRight":
      return <svg {...shared}><path d="M6 18 18 6M8 6h10v10" /></svg>;
    case "sparkle":
      return <svg {...shared}><path d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3ZM18.5 14l.7 2.8L22 17.5l-2.8.7-.7 2.8-.7-2.8-2.8-.7 2.8-.7.7-2.8ZM5.5 15l.6 2.1 2.1.6-2.1.6-.6 2.1-.6-2.1-2.1-.6 2.1-.6.6-2.1Z" /></svg>;
    case "close":
      return <svg {...shared}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    default:
      return null;
  }
}

function DashboardBarChart({ series, title }: { series: readonly DashboardChartPoint[]; title: string }) {
  const maxValue = Math.max(...series.map((point) => point.value), 1);
  const width = 360;
  const height = 180;
  const padding = { top: 12, right: 8, bottom: 28, left: 8 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const gap = 12;
  const barWidth = (chartWidth - gap * (series.length - 1)) / series.length;

  return (
    <svg className={styles.dashboardChartSvg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      {series.map((point, index) => {
        const barHeight = (point.value / maxValue) * chartHeight;
        const x = padding.left + index * (barWidth + gap);
        const y = padding.top + chartHeight - barHeight;
        return (
          <g key={point.label}>
            <rect
              className={styles.dashboardBar}
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(barHeight, 2)}
              rx="6"
            />
            <text className={styles.dashboardChartLabel} x={x + barWidth / 2} y={height - 8} textAnchor="middle">
              {point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function DashboardLineChart({ series, title }: { series: readonly DashboardChartPoint[]; title: string }) {
  const maxValue = Math.max(...series.map((point) => point.value), 1);
  const minValue = Math.min(...series.map((point) => point.value), 0);
  const range = Math.max(maxValue - minValue, 1);
  const width = 360;
  const height = 180;
  const padding = { top: 16, right: 12, bottom: 28, left: 12 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const points = series.map((point, index) => {
    const x = padding.left + (series.length === 1 ? chartWidth / 2 : (index / (series.length - 1)) * chartWidth);
    const y = padding.top + chartHeight - ((point.value - minValue) / range) * chartHeight;
    return { ...point, x, y };
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z`;

  return (
    <svg className={styles.dashboardChartSvg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <path className={styles.dashboardLineArea} d={areaPath} />
      <path className={styles.dashboardLinePath} d={linePath} />
      {points.map((point) => (
        <g key={point.label}>
          <circle className={styles.dashboardLineDot} cx={point.x} cy={point.y} r="3.5" />
          <text className={styles.dashboardChartLabel} x={point.x} y={height - 8} textAnchor="middle">
            {point.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  attachment?: string;
  isStreaming?: boolean;
  events?: TraceEvent[];
  runtime?: "fixture" | "openai";
  suppressEnter?: boolean;
  animateReveal?: boolean;
};

type ChatClarification = {
  question: string;
  options: [string, string];
};

const traceEventTypes = new Set([
  "progress",
  "narrative",
  "query",
  "table",
  "chart",
  "validation",
  "answer",
  "clarification",
  "error",
]);

function parseTraceEvent(value: unknown): TraceEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.sequence !== "number"
    || typeof candidate.type !== "string"
    || !traceEventTypes.has(candidate.type)
    || typeof candidate.occurredAt !== "string"
  ) {
    return null;
  }
  return candidate as unknown as TraceEvent;
}

export default function DashPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [accountEmail, setAccountEmail] = useState("");
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [activeItem, setActiveItem] = useState("Dashboard");
  const [activeTab, setActiveTab] = useState(pageTabs.Chat[0]);
  const [dashboardList, setDashboardList] = useState<DashboardView[]>(starterDashboards);
  const [activeDashboard, setActiveDashboard] = useState(starterDashboards[0].id);
  const [activeRange, setActiveRange] = useState(timeRanges[0]);
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [tableDensity, setTableDensity] = useState<"normal" | "compact">("normal");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [albertPopupOpen, setAlbertPopupOpen] = useState(false);
  const [albertPopupClosing, setAlbertPopupClosing] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [agentPreferences, setAgentPreferences] = useState<AgentRunPreferences>(DEFAULT_AGENT_PREFERENCES);
  const [isChatResponding, setIsChatResponding] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatClarification, setChatClarification] = useState<ChatClarification | null>(null);
  const [clarifyDraft, setClarifyDraft] = useState("");
  const [liveTalkOpen, setLiveTalkOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [attachmentName, setAttachmentName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [agentFrequency, setAgentFrequency] = useState<AgentScheduleFrequency>("Daily");
  const [agentTime, setAgentTime] = useState(agentScheduleTimes[1]);
  const [agentDays, setAgentDays] = useState<string[]>(["Mon", "Wed", "Fri"]);
  const [agentTools, setAgentTools] = useState<Record<ConnectionId, boolean>>({
    lightspeed: true,
    xero: false,
    deputy: false,
  });
  const [frequencyIndicator, setFrequencyIndicator] = useState({ left: 0, width: 0 });
  const reduceMotion = useReducedMotion();
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0 });
  const [rangeIndicator, setRangeIndicator] = useState({ left: 0, width: 0 });
  const [dashboardTabIndicator, setDashboardTabIndicator] = useState({ left: 0, width: 0 });
  const tabBarRef = useRef<HTMLDivElement>(null);
  const rangeBarRef = useRef<HTMLDivElement>(null);
  const dashboardTabBarRef = useRef<HTMLDivElement>(null);
  const frequencyBarRef = useRef<HTMLDivElement>(null);
  const accountAreaRef = useRef<HTMLDivElement>(null);
  const liveTalkAreaRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const chatSpacerRef = useRef<HTMLDivElement>(null);
  const chatComposerRef = useRef<HTMLFormElement>(null);
  const lastPinnedUserMessageIdRef = useRef<number | null>(null);
  const composerOriginTopRef = useRef<number | null>(null);
  const chatPinAnimationsRef = useRef<Array<{ stop: () => void }>>([]);
  const chatPinTimerRef = useRef<number | undefined>(undefined);
  const composerExpandTimerRef = useRef<number | undefined>(undefined);
  const chatRequestAbortRef = useRef<AbortController | null>(null);
  const chatMessageSequenceRef = useRef(0);
  const albertPopupRef = useRef<HTMLElement>(null);
  const popupCloseButtonRef = useRef<HTMLButtonElement>(null);
  const popupPreviousFocusRef = useRef<HTMLElement | null>(null);
  const filteredItems = useMemo(
    () => navItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  const tabs = pageTabs[activeItem] ?? ["Overview"];
  const showHeaderTabs = activeItem !== "Connections" && activeItem !== "Dashboard";
  const activeDashboardView = dashboardList.find((dashboard) => dashboard.id === activeDashboard) ?? dashboardList[0];
  const agentPanelOpen = activeItem === "Chat" && activeTab === "Agent";
  const chatComposerHero = activeItem === "Chat" && !agentPanelOpen && chatMessages.length === 0;
  const chatComposerCompact = activeItem === "Chat" && !agentPanelOpen && !composerExpanded;
  const selectedAgent = activeItem === "Agents"
    ? exampleAgents.find((agent) => agent.id === selectedAgentId) ?? null
    : null;
  const agentsDetailOpen = activeItem === "Agents" && selectedAgent !== null;
  const showScheduleTime = agentFrequency === "Daily" || agentFrequency === "Weekly";
  const showScheduleDays = agentFrequency === "Weekly";
  const accountInitial = accountEmail.trim().charAt(0).toUpperCase() || "P";

  useEffect(() => {
    let isMounted = true;

    void supabase.auth.getUser().then(({ data }) => {
      if (isMounted) setAccountEmail(data.user?.email ?? "");
    });

    return () => {
      isMounted = false;
    };
  }, [supabase]);

  const createDashboard = () => {
    const nextDashboard = createBlankDashboard(dashboardList.length + 1);
    setDashboardList((list) => [...list, nextDashboard]);
    setActiveDashboard(nextDashboard.id);
  };

  useEffect(() => () => {
    chatRequestAbortRef.current?.abort();
    chatPinAnimationsRef.current.forEach((animation) => animation.stop());
    if (chatPinTimerRef.current !== undefined) window.clearTimeout(chatPinTimerRef.current);
    if (composerExpandTimerRef.current !== undefined) window.clearTimeout(composerExpandTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const container = chatMessagesRef.current;
    const spacer = chatSpacerRef.current;
    if (!container || !spacer || chatMessages.length === 0) {
      if (spacer) spacer.style.minHeight = "0px";
      lastPinnedUserMessageIdRef.current = null;
      composerOriginTopRef.current = null;
      return;
    }

    const topGap = 8;
    const gap = 10;

    const clearPinAnimations = () => {
      chatPinAnimationsRef.current.forEach((animation) => animation.stop());
      chatPinAnimationsRef.current = [];
      if (chatPinTimerRef.current !== undefined) {
        window.clearTimeout(chatPinTimerRef.current);
        chatPinTimerRef.current = undefined;
      }
    };

    const computeSpacerHeight = (userEl: HTMLElement) => {
      let contentAfter = 0;
      let sibling = userEl.nextElementSibling as HTMLElement | null;
      while (sibling && sibling !== spacer) {
        contentAfter += sibling.offsetHeight + gap;
        sibling = sibling.nextElementSibling as HTMLElement | null;
      }
      return Math.max(0, container.clientHeight - userEl.offsetHeight - contentAfter - topGap);
    };

    const resetFlyingStyles = (element: HTMLElement) => {
      element.style.position = "";
      element.style.top = "";
      element.style.left = "";
      element.style.width = "";
      element.style.zIndex = "";
      element.style.transform = "";
      element.style.opacity = "";
      element.style.transition = "";
      element.style.pointerEvents = "";
      element.style.willChange = "";
      element.style.margin = "";
    };

    const updateSpacerOnly = () => {
      const lastUserMessage = [...chatMessages].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) {
        spacer.style.minHeight = "0px";
        return;
      }
      const userEl = container.querySelector<HTMLElement>(`[data-message-id="${lastUserMessage.id}"]`);
      if (!userEl) return;
      if (userEl.style.position === "fixed") return;
      const nextHeight = computeSpacerHeight(userEl);
      const currentHeight = Number.parseFloat(spacer.style.minHeight) || 0;
      if (Math.abs(nextHeight - currentHeight) < 1) return;
      spacer.style.minHeight = `${nextHeight}px`;
    };

    const pinWithFlip = (userEl: HTMLElement, messageId: number) => {
      const firstRect = userEl.getBoundingClientRect();
      spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
      const userTop = userEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTop = Math.max(0, userTop - topGap);
      const lastRect = userEl.getBoundingClientRect();
      const dy = firstRect.top - lastRect.top;
      lastPinnedUserMessageIdRef.current = messageId;

      if (reduceMotion || Math.abs(dy) < 1) {
        resetFlyingStyles(userEl);
        return;
      }

      userEl.style.willChange = "transform";
      const flipAnimation = animate(dy, 0, {
        duration: 0.52,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (value) => {
          userEl.style.transform = `translateY(${value}px)`;
        },
        onComplete: () => {
          resetFlyingStyles(userEl);
        },
      });
      chatPinAnimationsRef.current.push(flipAnimation);
    };

    const pinFirstMessage = (userEl: HTMLElement, messageId: number, originTop: number) => {
      const assistantEl = userEl.nextElementSibling as HTMLElement | null;
      const startRect = userEl.getBoundingClientRect();

      userEl.style.position = "fixed";
      userEl.style.top = `${originTop}px`;
      userEl.style.left = `${startRect.left}px`;
      userEl.style.width = `${startRect.width}px`;
      userEl.style.zIndex = "6";
      userEl.style.margin = "0";
      userEl.style.willChange = "top, opacity";
      userEl.style.pointerEvents = "none";
      userEl.style.opacity = "0";
      userEl.style.transform = "none";

      if (assistantEl && assistantEl !== spacer) {
        assistantEl.style.opacity = "0";
      }

      spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
      container.scrollTop = 0;
      lastPinnedUserMessageIdRef.current = messageId;

      const destinationTop = container.getBoundingClientRect().top + topGap;

      const fadeAnimation = animate(0, 1, {
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (value) => {
          userEl.style.opacity = String(value);
        },
      });
      chatPinAnimationsRef.current.push(fadeAnimation);

      const slideAnimation = animate(originTop, destinationTop, {
        duration: 0.5,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (value) => {
          userEl.style.top = `${value}px`;
        },
        onComplete: () => {
          resetFlyingStyles(userEl);
          spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
          container.scrollTop = 0;
          if (assistantEl && assistantEl !== spacer) {
            const revealAnimation = animate(0, 1, {
              duration: 0.28,
              ease: [0.22, 1, 0.36, 1],
              onUpdate: (value) => {
                assistantEl.style.opacity = String(value);
              },
              onComplete: () => {
                assistantEl.style.opacity = "";
              },
            });
            chatPinAnimationsRef.current.push(revealAnimation);
          }
          composerOriginTopRef.current = null;
        },
      });
      chatPinAnimationsRef.current.push(slideAnimation);
    };

    const lastUserMessage = [...chatMessages].reverse().find((message) => message.role === "user");
    if (!lastUserMessage) {
      spacer.style.minHeight = "0px";
      return;
    }

    const userEl = container.querySelector<HTMLElement>(`[data-message-id="${lastUserMessage.id}"]`);
    if (!userEl) return;

    const alreadyPinned = lastPinnedUserMessageIdRef.current === lastUserMessage.id;
    if (alreadyPinned) {
      updateSpacerOnly();
    } else {
      clearPinAnimations();
      const originTop = composerOriginTopRef.current;
      if (originTop !== null && !reduceMotion) {
        pinFirstMessage(userEl, lastUserMessage.id, originTop);
      } else if (originTop !== null && reduceMotion) {
        spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
        container.scrollTop = 0;
        lastPinnedUserMessageIdRef.current = lastUserMessage.id;
        composerOriginTopRef.current = null;
      } else {
        pinWithFlip(userEl, lastUserMessage.id);
      }
    }

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        updateSpacerOnly();
      });
    });
    resizeObserver.observe(container);
    Array.from(container.children).forEach((child) => {
      if (child !== spacer) resizeObserver.observe(child);
    });

    return () => {
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
    };
  }, [chatMessages, reduceMotion]);

  useLayoutEffect(() => {
    const updateIndicator = (
      container: HTMLDivElement | null,
      setIndicator: (value: { left: number; width: number }) => void,
    ) => {
      const activeButton = container?.querySelector<HTMLButtonElement>("[data-active='true']");
      if (!container || !activeButton) return;
      const containerRect = container.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      setIndicator({
        left: buttonRect.left - containerRect.left,
        width: buttonRect.width,
      });
    };

    const updateIndicators = () => {
      updateIndicator(tabBarRef.current, setTabIndicator);
      updateIndicator(rangeBarRef.current, setRangeIndicator);
      updateIndicator(dashboardTabBarRef.current, setDashboardTabIndicator);
      updateIndicator(frequencyBarRef.current, setFrequencyIndicator);
    };

    updateIndicators();
    window.addEventListener("resize", updateIndicators);
    return () => window.removeEventListener("resize", updateIndicators);
  }, [activeItem, activeTab, activeDashboard, activeRange, agentFrequency, agentPanelOpen]);

  useEffect(() => {
    if (!accountOpen) return;

    const closeMenuOnOutsidePress = (event: PointerEvent) => {
      if (!accountAreaRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountOpen(false);
    };

    document.addEventListener("pointerdown", closeMenuOnOutsidePress);
    document.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenuOnOutsidePress);
      document.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [accountOpen]);

  useEffect(() => {
    if (!liveTalkOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!liveTalkAreaRef.current?.contains(event.target as Node)) {
        setLiveTalkOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLiveTalkOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [liveTalkOpen]);

  useEffect(() => {
    if (!albertPopupOpen) {
      popupPreviousFocusRef.current?.focus();
      return;
    }

    const closePopupOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAlbertPopupClosing(true);

      if (event.key !== "Tab") return;

      const focusableElements = albertPopupRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusableElements?.length) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    popupPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closePopupOnEscape);
    const focusPopup = window.requestAnimationFrame(() => popupCloseButtonRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closePopupOnEscape);
      window.cancelAnimationFrame(focusPopup);
    };
  }, [albertPopupOpen]);

  useEffect(() => {
    if (!albertPopupClosing) return;

    const closeTimer = window.setTimeout(() => {
      setAlbertPopupOpen(false);
      setAlbertPopupClosing(false);
    }, 180);

    return () => window.clearTimeout(closeTimer);
  }, [albertPopupClosing]);

  const sendChatMessage = async (suggestedText?: string) => {
    const text = (suggestedText ?? chatDraft).trim();
    const attachment = suggestedText ? "" : attachmentName;
    if ((!text && !attachment) || isChatResponding) return;

    chatMessageSequenceRef.current += 2;
    const userId = chatMessageSequenceRef.current - 1;
    const assistantId = chatMessageSequenceRef.current;
    const firstFlight = chatMessages.length === 0;
    if (firstFlight && chatComposerRef.current) {
      composerOriginTopRef.current = chatComposerRef.current.getBoundingClientRect().top;
    } else {
      composerOriginTopRef.current = null;
    }

    setChatMessages((messages) => [
      ...messages,
      { id: userId, role: "user", text, attachment: attachment || undefined, suppressEnter: firstFlight },
      { id: assistantId, role: "assistant", text: "", isStreaming: true, events: [], suppressEnter: firstFlight },
    ]);
    if (firstFlight) {
      if (composerExpandTimerRef.current !== undefined) {
        window.clearTimeout(composerExpandTimerRef.current);
      }
      if (reduceMotion) {
        setComposerExpanded(true);
      } else {
        composerExpandTimerRef.current = window.setTimeout(() => {
          setComposerExpanded(true);
          composerExpandTimerRef.current = undefined;
        }, 300);
      }
    }
    setChatDraft("");
    setAttachmentName("");
    setChatHistoryOpen(false);
    setChatClarification(null);
    setClarifyDraft("");
    setIsChatResponding(true);

    chatRequestAbortRef.current?.abort();
    const controller = new AbortController();
    chatRequestAbortRef.current = controller;
    const receivedEvents: TraceEvent[] = [];

    const updateAssistant = (patch: Partial<ChatMessage>) => {
      setChatMessages((messages) => messages.map((message) => (
        message.id === assistantId ? { ...message, ...patch } : message
      )));
    };

    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, preferences: agentPreferences }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Albert could not start this analysis.");
      }

      const runtime = response.headers.get("X-Albert-Runtime") === "openai" ? "openai" : "fixture";
      updateAssistant({ runtime });

      if (!response.body) throw new Error("The conversation stream was unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const acceptBlock = (block: string) => {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) return;

        const event = parseTraceEvent(JSON.parse(data));
        if (!event || receivedEvents.some((item) => item.id === event.id)) return;
        receivedEvents.push(event);
        receivedEvents.sort((first, second) => first.sequence - second.sequence);
        updateAssistant({ events: [...receivedEvents] });
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          acceptBlock(block);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (buffer.trim()) acceptBlock(buffer);
      if (receivedEvents.length === 0) throw new Error("Albert returned an empty analysis trace.");

      updateAssistant({ isStreaming: false, events: [...receivedEvents] });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Albert could not complete this analysis.";
      const errorEvent: TraceEvent = {
        id: `trace_error_${assistantId}`,
        sequence: receivedEvents.length + 1,
        type: "error",
        status: "error",
        occurredAt: new Date().toISOString(),
        message,
        recoverable: true,
      };
      updateAssistant({ isStreaming: false, events: [...receivedEvents, errorEvent] });
    } finally {
      if (chatRequestAbortRef.current === controller) chatRequestAbortRef.current = null;
      if (!controller.signal.aborted) setIsChatResponding(false);
    }
  };

  const answerClarification = (answer: string) => {
    const text = answer.trim();
    if (!text || isChatResponding) return;
    setChatClarification(null);
    setClarifyDraft("");
    void sendChatMessage(text);
  };

  const openAlbertChat = () => {
    setActiveItem("Chat");
    setActiveTab(pageTabs.Chat[0]);
    setChatHistoryOpen(false);
    setAlbertPopupClosing(true);
  };

  const openAlbertPopup = () => {
    setAlbertPopupClosing(false);
    setAlbertPopupOpen(true);
  };

  const startNewChat = () => {
    chatRequestAbortRef.current?.abort();
    chatRequestAbortRef.current = null;
    chatPinAnimationsRef.current.forEach((animation) => animation.stop());
    chatPinAnimationsRef.current = [];
    if (chatPinTimerRef.current !== undefined) {
      window.clearTimeout(chatPinTimerRef.current);
      chatPinTimerRef.current = undefined;
    }
    lastPinnedUserMessageIdRef.current = null;
    composerOriginTopRef.current = null;
    if (composerExpandTimerRef.current !== undefined) {
      window.clearTimeout(composerExpandTimerRef.current);
      composerExpandTimerRef.current = undefined;
    }
    setChatMessages([]);
    setChatDraft("");
    setAttachmentName("");
    setIsChatResponding(false);
    setChatHistoryOpen(false);
    setLiveTalkOpen(false);
    setComposerExpanded(false);
    setChatClarification(null);
    setClarifyDraft("");
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);

    const { error } = await supabase.auth.signOut();

    if (error) {
      setIsSigningOut(false);
      return;
    }

    router.replace("/login");
    router.refresh();
  };

  return (
    <main
      className={`${styles.dash} ${collapsed ? styles.collapsed : ""}`}
      data-theme={theme}
    >
      <aside className={styles.sidebar} inert={albertPopupOpen}>
        <div className={styles.sidebarHeader}>
          <div className={styles.projectBrand}>
            <span className={styles.projectName}>Albert</span>
          </div>
          <button
            className={styles.collapseButton}
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((value) => !value)}
          >
            <Icon name="panel" />
          </button>
        </div>

        <label className={styles.searchBox}>
          <Icon name="search" />
          <input
            aria-label="Search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>

        <nav className={styles.navigation} aria-label="Project navigation">
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => {
              const isActive = item.label === activeItem;
              return (
                <button
                  className={`${styles.navItem} ${isActive ? styles.active : ""}`}
                  key={item.label}
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => {
                    setActiveItem(item.label);
                    const nextTabs = pageTabs[item.label];
                    if (nextTabs?.[0]) setActiveTab(nextTabs[0]);
                    setChatHistoryOpen(false);
                    if (item.label !== "Agents") setSelectedAgentId(null);
                  }}
                >
                  <Icon name={item.icon} />
                  <span className={styles.navLabel}>{item.label}</span>
                </button>
              );
            })
          ) : (
            <p className={styles.noResults}>No matches</p>
          )}
        </nav>

        <div className={styles.accountArea} ref={accountAreaRef}>
          <div
            className={`${styles.accountPopover} ${accountOpen ? styles.accountPopoverOpen : ""}`}
            role="dialog"
            aria-label="Account menu"
            aria-hidden={!accountOpen}
            inert={!accountOpen}
          >
            <p className={styles.accountEmail}>{accountEmail || "Signed in"}</p>
            <div className={styles.themeSwitcher} aria-label="Theme" role="group">
              {themeOptions.map((option) => (
                <button
                  className={theme === option.value ? styles.themeActive : ""}
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={theme === option.value}
                  onClick={() => setThemePreference(option.value)}
                >
                  <Icon name={option.icon} />
                </button>
              ))}
            </div>

            <div className={styles.accountDivider} />

            <button className={styles.accountWorkspace} type="button">
              <span className={styles.accountAvatar}>{accountInitial}</span>
              <span className={styles.accountWorkspaceCopy}>
                <strong>Personal</strong>
                <small>Organization</small>
              </span>
              <Icon name="chevron" />
            </button>

            <div className={styles.accountDivider} />

            <div className={styles.accountLinks}>
              <button type="button"><Icon name="organization" /><span>Organization settings</span></button>
              <button type="button"><Icon name="profile" /><span>Profile settings</span></button>
            </div>

            <div className={styles.accountDivider} />

            <div className={styles.accountLinks}>
              <button type="button"><Icon name="docs" /><span>Developer docs</span></button>
              <button type="button"><Icon name="terms" /><span>Terms &amp; policies</span></button>
              <button type="button"><Icon name="help" /><span>Help</span></button>
            </div>

            <div className={styles.accountDivider} />

            <button
              className={styles.logoutButton}
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              <Icon name="logout" />
              <span>{isSigningOut ? "Logging out…" : "Log out"}</span>
            </button>
          </div>

          <button
            className={styles.accountTrigger}
            type="button"
            aria-expanded={accountOpen}
            aria-haspopup="dialog"
            onClick={() => setAccountOpen((value) => !value)}
          >
            <span className={styles.accountAvatar}>{accountInitial}</span>
            <span className={styles.accountWorkspaceCopy}>
              <strong>Personal</strong>
              <small>Organization</small>
            </span>
          </button>
        </div>
      </aside>

      <section className={styles.content} aria-labelledby="dash-title" inert={albertPopupOpen}>
        <header className={`${styles.pageHeader} ${!showHeaderTabs ? styles.pageHeaderSimple : ""}`}>
          <div className={styles.pageHeaderTop}>
            <h1 id="dash-title">{activeItem}</h1>
            {showHeaderTabs ? (
              <div className={styles.headerActions}>
                <button
                  className={styles.albertTrigger}
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={albertPopupOpen}
                  onClick={openAlbertPopup}
                >
                  <Icon name="sparkle" />
                  <span>Try Albert</span>
                </button>
                <div className={styles.rangeBar} ref={rangeBarRef} role="tablist" aria-label="Time range">
                  {timeRanges.map((range) => (
                    <button
                      className={`${styles.rangeButton} ${activeRange === range ? styles.rangeActive : ""}`}
                      key={range}
                      type="button"
                      role="tab"
                      aria-selected={activeRange === range}
                      data-active={activeRange === range}
                      onClick={() => setActiveRange(range)}
                    >
                      {range}
                    </button>
                  ))}
                  <span
                    className={styles.rangeIndicator}
                    style={{ left: rangeIndicator.left, width: rangeIndicator.width }}
                    aria-hidden="true"
                  />
                </div>
              </div>
            ) : null}
          </div>
          {showHeaderTabs ? (
            <div className={styles.headerSubnav}>
              <div className={styles.tabBar} ref={tabBarRef} role="tablist" aria-label={`${activeItem} views`}>
                {tabs.map((tab) => (
                  <button
                    className={`${styles.tabButton} ${activeTab === tab ? styles.tabActive : ""}`}
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    data-active={activeTab === tab}
                    onClick={() => {
                      setActiveTab(tab);
                      if (tab === "Agent") setChatHistoryOpen(false);
                    }}
                  >
                    {tab}
                  </button>
                ))}
                <span
                  className={styles.tabIndicator}
                  style={{ left: tabIndicator.left, width: tabIndicator.width }}
                  aria-hidden="true"
                />
              </div>
            </div>
          ) : null}
        </header>
        {activeItem === "Dashboard" ? (
          <div className={styles.dashboardWorkspace}>
            <div className={styles.dashboardCanvas} aria-live="polite">
              <div className={styles.dashboardGridSurface} aria-hidden="true" />
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  className={styles.dashboardCanvasPanel}
                  key={activeDashboardView.id}
                  initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                  transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className={styles.dashboardBoardHeader}>
                    <div>
                      <p className={styles.contentEyebrow}>GRIDDED CANVAS</p>
                      <h2>{activeDashboardView.title}</h2>
                      <p className={styles.contentDescription}>{activeDashboardView.description}</p>
                    </div>
                  </div>

                  <div className={styles.dashboardBoard}>
                    <div className={styles.dashboardMetricGrid} role="list" aria-label={`${activeDashboardView.label} metrics`}>
                      {activeDashboardView.metrics.map((metric) => (
                        <article className={styles.dashboardMetric} key={metric.label} role="listitem">
                          <div className={styles.dashboardMetricTop}>
                            <span>{metric.label}</span>
                            <small>{metric.delta}</small>
                          </div>
                          <strong>{metric.value}</strong>
                        </article>
                      ))}
                    </div>

                    <section className={styles.dashboardWidget} aria-label={activeDashboardView.table.title}>
                      <div className={styles.dashboardWidgetHeader}>
                        <h3>{activeDashboardView.table.title}</h3>
                        <div className={styles.tableDensity} role="group" aria-label="Table row size">
                          <button
                            type="button"
                            className={tableDensity === "compact" ? styles.tableDensityActive : ""}
                            aria-pressed={tableDensity === "compact"}
                            onClick={() => setTableDensity("compact")}
                          >
                            Compact
                          </button>
                          <button
                            type="button"
                            className={tableDensity === "normal" ? styles.tableDensityActive : ""}
                            aria-pressed={tableDensity === "normal"}
                            onClick={() => setTableDensity("normal")}
                          >
                            Normal
                          </button>
                        </div>
                      </div>
                      <div className={styles.dashboardTableWrap}>
                        <table
                          className={`${styles.dashboardTable} ${tableDensity === "compact" ? styles.tableCompact : ""}`}
                        >
                          <thead>
                            <tr>
                              {activeDashboardView.table.columns.map((column) => (
                                <th key={column} scope="col">{column}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {activeDashboardView.table.rows.map((row) => (
                              <tr key={row.join("-")}>
                                {row.map((cell, cellIndex) => (
                                  <td key={`${row[0]}-${cellIndex}`}>{cell}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <div className={styles.dashboardChartRow}>
                      <section className={styles.dashboardWidget} aria-label={activeDashboardView.barChart.title}>
                        <div className={styles.dashboardWidgetHeader}>
                          <h3>{activeDashboardView.barChart.title}</h3>
                          <span>Bar chart</span>
                        </div>
                        <DashboardBarChart
                          series={activeDashboardView.barChart.series}
                          title={activeDashboardView.barChart.title}
                        />
                      </section>

                      <section className={styles.dashboardWidget} aria-label={activeDashboardView.lineChart.title}>
                        <div className={styles.dashboardWidgetHeader}>
                          <h3>{activeDashboardView.lineChart.title}</h3>
                          <span>Line graph</span>
                        </div>
                        <DashboardLineChart
                          series={activeDashboardView.lineChart.series}
                          title={activeDashboardView.lineChart.title}
                        />
                      </section>
                    </div>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            <div className={styles.dashboardTabDock}>
              <div
                className={styles.dashboardTabBar}
                ref={dashboardTabBarRef}
                role="tablist"
                aria-label="Dashboards"
              >
                {dashboardList.map((dashboard) => {
                  const isActive = activeDashboard === dashboard.id;
                  return (
                    <button
                      className={`${styles.dashboardTabButton} ${isActive ? styles.dashboardTabActive : ""}`}
                      key={dashboard.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      data-active={isActive}
                      onClick={() => setActiveDashboard(dashboard.id)}
                    >
                      {dashboard.label}
                    </button>
                  );
                })}
                <button
                  className={styles.dashboardTabButton}
                  type="button"
                  aria-label="New dashboard"
                  onClick={createDashboard}
                >
                  <Icon name="plus" />
                  <span>New</span>
                </button>
                <span
                  className={styles.dashboardTabIndicator}
                  style={{ left: dashboardTabIndicator.left, width: dashboardTabIndicator.width }}
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>
        ) : activeItem === "Chat" ? (
          <div className={`${styles.chatShell} ${agentPanelOpen ? styles.chatShellAgentOpen : ""}`}>
          <div
            className={`${styles.chatWorkspace} ${chatHistoryOpen ? styles.chatWorkspaceHistoryOpen : ""}`}
          >
            {!agentPanelOpen && chatMessages.length > 0 ? (
              <button
                className={styles.chatNewChat}
                type="button"
                onClick={startNewChat}
              >
                <Icon name="plus" />
                <span>New Chat</span>
              </button>
            ) : null}
            {chatMessages.length > 0 ? (
              <div className={styles.chatMessages} aria-live="polite" ref={chatMessagesRef}>
                {chatMessages.map((message) => {
                  const suppressEnter = Boolean(
                    reduceMotion || message.suppressEnter,
                  );
                  return (
                  <motion.article
                    className={`${styles.chatMessage} ${message.role === "assistant" ? styles.chatMessageAssistant : styles.chatMessageUser}`}
                    data-message-id={message.id}
                    key={message.id}
                    initial={suppressEnter ? false : { opacity: 0 }}
                    animate={suppressEnter ? false : { opacity: 1 }}
                    transition={{
                      duration: 0.34,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    {message.role === "assistant" ? (
                      <>
                        {message.events?.length ? (
                          <AnalyticalTrace
                            events={message.events}
                            streaming={message.isStreaming}
                            runtime={message.runtime}
                            onFollowUp={(prompt) => void sendChatMessage(prompt)}
                            onClarification={answerClarification}
                          />
                        ) : message.isStreaming ? (
                          <div className={styles.chatTraceConnecting} role="status">
                            <span aria-hidden="true" />
                            Opening a governed analysis…
                          </div>
                        ) : (
                          <span className={styles.chatMessageLabel}>Albert</span>
                        )}
                        {message.isStreaming ? null : message.text ? (
                          <motion.div
                            className={styles.chatMessageReveal}
                            initial={
                              reduceMotion || !message.animateReveal
                                ? false
                                : { opacity: 0, clipPath: "inset(0 0 100% 0)" }
                            }
                            animate={{ opacity: 1, clipPath: "inset(0 0 -8% 0)" }}
                            transition={{ duration: 2.2, ease: [0.22, 1, 0.36, 1] }}
                          >
                            <p>{message.text}</p>
                          </motion.div>
                        ) : null}
                      </>
                    ) : (
                      <>
                        {message.text ? <p>{message.text}</p> : null}
                        {message.attachment ? <span>{message.attachment}</span> : null}
                      </>
                    )}
                  </motion.article>
                  );
                })}
                <div className={styles.chatScrollSpacer} ref={chatSpacerRef} aria-hidden="true" />
              </div>
            ) : (
              <div className={styles.chatEmptyGrow} aria-hidden="true" />
            )}

            {chatHistoryOpen ? (
              <section id="conversation-history" className={styles.chatHistoryPanel} aria-label="Conversation history">
                <div className={styles.chatHistoryHeader}>
                  <div>
                    <p className={styles.chatHistoryEyebrow}>CONVERSATIONS</p>
                    <h2>History</h2>
                  </div>
                  <button
                    className={styles.chatHistoryClose}
                    type="button"
                    aria-label="Close conversation history"
                    onClick={() => setChatHistoryOpen(false)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <div className={styles.chatHistoryList}>
                  {recentConversations.map((conversation, index) => (
                    <button
                      className={`${styles.chatHistoryItem} ${index === 0 ? styles.chatHistoryItemActive : ""}`}
                      type="button"
                      key={conversation.title}
                      onClick={() => setChatHistoryOpen(false)}
                    >
                      <span className={styles.chatHistoryItemIcon}><Icon name="chat" /></span>
                      <span className={styles.chatHistoryItemCopy}>
                        <strong>{conversation.title}</strong>
                        <small>{conversation.meta}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <motion.div
              className={`${styles.chatComposerStack} ${chatComposerCompact ? styles.chatComposerStackHero : ""} ${chatClarification && !agentPanelOpen ? styles.chatComposerStackConnected : ""}`}
            >
              <AnimatePresence initial={false}>
                {chatComposerHero ? (
                  <motion.h2
                    key="chat-hero-title"
                    className={styles.chatHeroTitle}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.32,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    Ask me anything
                  </motion.h2>
                ) : null}
              </AnimatePresence>
              <AnimatePresence initial={false}>
                {chatClarification && !agentPanelOpen ? (
                  <motion.div
                    key="chat-clarify"
                    className={styles.chatClarify}
                    role="region"
                    aria-label="Clarification needed"
                    initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: 6 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.28,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <h3 className={styles.chatClarifyQuestion}>{chatClarification.question}</h3>
                    <div className={styles.chatClarifyOptions} role="group" aria-label="Suggested answers">
                      {chatClarification.options.map((option) => (
                        <button
                          className={styles.chatClarifyOption}
                          key={option}
                          type="button"
                          onClick={() => answerClarification(option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                    <div className={styles.chatClarifyManual}>
                      <input
                        className={styles.chatClarifyInput}
                        type="text"
                        value={clarifyDraft}
                        placeholder="Or type your own answer"
                        aria-label="Type your own clarification answer"
                        onChange={(event) => setClarifyDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            answerClarification(clarifyDraft);
                          }
                        }}
                      />
                      <button
                        className={styles.chatClarifySend}
                        type="button"
                        aria-label="Send clarification"
                        disabled={!clarifyDraft.trim()}
                        onClick={() => answerClarification(clarifyDraft)}
                      >
                        <Icon name="arrowUp" />
                      </button>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

            <motion.form
              ref={chatComposerRef}
              className={`${styles.chatComposer} ${chatComposerCompact ? styles.chatComposerHero : ""} ${agentPanelOpen ? styles.chatComposerAgent : ""}`}
              initial={false}
              animate={
                agentPanelOpen
                  ? undefined
                  : {
                      borderRadius: chatComposerCompact ? 999 : 20,
                      paddingTop: chatComposerCompact ? 12 : 12,
                      paddingBottom: chatComposerCompact ? 12 : 10,
                      paddingLeft: chatComposerCompact ? 20 : 13,
                      paddingRight: chatComposerCompact ? 12 : 13,
                    }
              }
              transition={{
                duration: reduceMotion ? 0 : 0.45,
                ease: [0.22, 1, 0.36, 1],
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (agentPanelOpen) return;
                void sendChatMessage();
              }}
            >
              {!agentPanelOpen && !chatComposerCompact && attachmentName ? (
                <div className={styles.attachmentRow}>
                  <span>{attachmentName}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachmentName}`}
                    onClick={() => setAttachmentName("")}
                  >
                    ×
                  </button>
                </div>
              ) : null}
              <div className={styles.chatComposerInputRow}>
                <textarea
                  aria-label={agentPanelOpen ? "Design your agent" : "Ask me anything"}
                  placeholder={
                    agentPanelOpen
                      ? "Design your agent…"
                      : chatComposerHero
                        ? "Type a message…"
                        : "Search or ask anything"
                  }
                  rows={1}
                  value={agentPanelOpen ? agentInstructions : chatDraft}
                  onChange={(event) => {
                    if (agentPanelOpen) {
                      setAgentInstructions(event.target.value);
                      return;
                    }
                    setChatDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (agentPanelOpen) return;
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendChatMessage();
                    }
                  }}
                />
              </div>
              {agentPanelOpen ? (
                <div className={styles.chatComposerFooter}>
                  <span className={styles.agentComposerHint}>Describe what this agent should do</span>
                  <button
                    className={styles.chatSendButton}
                    type="button"
                    aria-label="Apply agent description"
                    disabled={!agentInstructions.trim()}
                    onClick={() => {
                      if (!agentName.trim() && agentInstructions.trim()) {
                        setAgentName(agentInstructions.trim().slice(0, 48));
                      }
                    }}
                  >
                    <Icon name="sparkle" />
                  </button>
                </div>
              ) : (
                <>
                  <input
                    ref={attachmentInputRef}
                    className={styles.fileInput}
                    type="file"
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) setAttachmentName(file.name);
                      event.currentTarget.value = "";
                    }}
                  />
                  <motion.div
                    className={styles.chatComposerFooter}
                    initial={false}
                    animate={{
                      height: chatComposerCompact ? 0 : 32,
                      marginTop: chatComposerCompact ? 0 : 10,
                      opacity: chatComposerCompact ? 0 : 1,
                    }}
                    transition={{
                      height: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                      marginTop: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                      opacity: {
                        duration: reduceMotion ? 0 : 0.28,
                        delay: reduceMotion || chatComposerCompact ? 0 : 0.12,
                        ease: "easeOut",
                      },
                    }}
                    style={{ overflow: "hidden" }}
                    aria-hidden={chatComposerCompact}
                    inert={chatComposerCompact || undefined}
                  >
                    <div className={styles.chatComposerTools}>
                      <button
                        className={styles.chatHistoryTrigger}
                        type="button"
                        tabIndex={chatComposerCompact ? -1 : undefined}
                        aria-expanded={chatHistoryOpen}
                        aria-controls="conversation-history"
                        onClick={() => setChatHistoryOpen((open) => !open)}
                      >
                        <Icon name="panel" />
                        <span>History</span>
                      </button>
                      <ModelRunControls
                        value={agentPreferences}
                        onChange={setAgentPreferences}
                        runActive={isChatResponding}
                        compact
                      />
                      <button
                        className={styles.composerIconButton}
                        type="button"
                        tabIndex={chatComposerCompact ? -1 : undefined}
                        aria-label="Add attachment"
                        onClick={() => attachmentInputRef.current?.click()}
                      >
                        <Icon name="plus" />
                      </button>
                      <div className={styles.composerLiveTalk} ref={liveTalkAreaRef}>
                        <AnimatePresence>
                          {liveTalkOpen ? (
                            <motion.div
                              key="composer-live-talk"
                              className={styles.liveTalkPanel}
                              role="dialog"
                              aria-label="Live talk"
                              initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.88 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={reduceMotion ? undefined : { opacity: 0, y: 10, scale: 0.94 }}
                              transition={{
                                duration: reduceMotion ? 0 : 0.42,
                                ease: [0.34, 1.56, 0.64, 1],
                              }}
                            >
                              <div className={styles.liveTalkPanelHeader}>
                                <div className={styles.liveTalkPanelCopy}>
                                  <p className={styles.liveTalkPanelEyebrow}>
                                    <span className={styles.liveTalkLiveDot} aria-hidden="true" />
                                    Live
                                  </p>
                                  <h2>Talk with Albert</h2>
                                  <p className={styles.liveTalkPanelHint}>Listening for your next thought</p>
                                </div>
                                <button
                                  className={styles.liveTalkPanelClose}
                                  type="button"
                                  aria-label="Close live talk"
                                  onClick={() => setLiveTalkOpen(false)}
                                >
                                  <Icon name="close" />
                                </button>
                              </div>

                              <div className={styles.liveTalkWave} aria-hidden="true">
                                {Array.from({ length: 18 }, (_, index) => (
                                  <span
                                    key={index}
                                    className={styles.liveTalkBar}
                                    style={{ animationDelay: `${(index % 9) * 0.08}s` }}
                                  />
                                ))}
                              </div>

                              <div className={styles.liveTalkActions}>
                                <button
                                  className={styles.liveTalkEnd}
                                  type="button"
                                  onClick={() => setLiveTalkOpen(false)}
                                >
                                  End talk
                                </button>
                              </div>
                            </motion.div>
                          ) : null}
                        </AnimatePresence>

                        <button
                          className={`${styles.composerLiveTalkButton} ${liveTalkOpen ? styles.composerLiveTalkButtonActive : ""}`}
                          type="button"
                          tabIndex={chatComposerCompact ? -1 : undefined}
                          aria-label="Live talk"
                          aria-expanded={liveTalkOpen}
                          aria-haspopup="dialog"
                          onClick={() => {
                            setChatHistoryOpen(false);
                            setLiveTalkOpen((open) => !open);
                          }}
                        >
                          <Icon name="mic" />
                          <span className={styles.liveTalkPulse} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                  <motion.button
                    className={styles.chatSendButton}
                    type="submit"
                    layout={!reduceMotion ? "position" : false}
                    transition={{
                      layout: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                    }}
                    aria-label={isChatResponding ? "Albert is responding" : "Send message"}
                    disabled={isChatResponding || (!chatDraft.trim() && !attachmentName)}
                  >
                    <Icon name="arrowUp" />
                  </motion.button>
                </>
              )}
            </motion.form>
            </motion.div>

            <motion.div
              className={styles.chatEmptyGrow}
              aria-hidden="true"
              initial={false}
              animate={{ flexGrow: chatMessages.length === 0 ? 1 : 0 }}
              transition={{
                duration: reduceMotion ? 0 : 0.5,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          </div>

          <aside
            className={`${styles.agentCreatePanel} ${agentPanelOpen ? styles.agentCreatePanelOpen : ""}`}
            role="dialog"
            aria-modal="false"
            aria-labelledby="agent-create-title"
            aria-hidden={!agentPanelOpen}
            inert={!agentPanelOpen}
          >
                <div className={styles.agentCreateHeader}>
                  <h2 id="agent-create-title">Create Agent</h2>
                  <button
                    className={styles.agentCreateClose}
                    type="button"
                    aria-label="Close agent creator"
                    onClick={() => setActiveTab("Playground")}
                  >
                    <Icon name="close" />
                  </button>
                </div>

                <div className={styles.agentCreateBody}>
                  <label className={styles.agentField}>
                    <span>Name</span>
                    <input
                      className={styles.agentInput}
                      type="text"
                      placeholder="Weekly sales briefing"
                      value={agentName}
                      onChange={(event) => setAgentName(event.target.value)}
                    />
                  </label>

                  <div className={styles.agentField}>
                    <span>Schedule</span>
                    <div
                      className={styles.agentFrequencyBar}
                      ref={frequencyBarRef}
                      role="tablist"
                      aria-label="Run frequency"
                    >
                      {agentScheduleFrequencies.map((frequency) => (
                        <button
                          className={`${styles.agentFrequencyButton} ${agentFrequency === frequency ? styles.agentFrequencyActive : ""}`}
                          key={frequency}
                          type="button"
                          role="tab"
                          aria-selected={agentFrequency === frequency}
                          data-active={agentFrequency === frequency}
                          onClick={() => setAgentFrequency(frequency)}
                        >
                          {frequency}
                        </button>
                      ))}
                      <span
                        className={styles.agentFrequencyIndicator}
                        style={{ left: frequencyIndicator.left, width: frequencyIndicator.width }}
                        aria-hidden="true"
                      />
                    </div>
                  </div>

                  {showScheduleTime ? (
                    <div className={styles.agentField}>
                      <span>Run time</span>
                      <div className={styles.agentTimeGrid} role="group" aria-label="Run time">
                        {agentScheduleTimes.map((time) => (
                          <button
                            className={`${styles.agentTimeButton} ${agentTime === time ? styles.agentTimeActive : ""}`}
                            key={time}
                            type="button"
                            aria-pressed={agentTime === time}
                            onClick={() => setAgentTime(time)}
                          >
                            {time}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {showScheduleDays ? (
                    <div className={styles.agentField}>
                      <span>Days</span>
                      <div className={styles.agentDayGrid} role="group" aria-label="Run days">
                        {agentScheduleDays.map((day) => {
                          const selected = agentDays.includes(day);
                          return (
                            <button
                              className={`${styles.agentDayButton} ${selected ? styles.agentDayActive : ""}`}
                              key={day}
                              type="button"
                              aria-pressed={selected}
                              onClick={() => {
                                setAgentDays((days) => (
                                  selected
                                    ? days.filter((value) => value !== day)
                                    : [...days, day]
                                ));
                              }}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  <div className={styles.agentField}>
                    <span>Tools</span>
                    <div className={styles.agentToolList}>
                      {connectionProviders.map((provider) => {
                        const enabled = agentTools[provider.id];
                        return (
                          <button
                            className={`${styles.agentToolRow} ${enabled ? styles.agentToolActive : ""}`}
                            key={provider.id}
                            type="button"
                            aria-pressed={enabled}
                            onClick={() => {
                              setAgentTools((tools) => ({
                                ...tools,
                                [provider.id]: !tools[provider.id],
                              }));
                            }}
                          >
                            <span className={styles.agentToolLogo} data-provider={provider.id}>
                              <Image src={provider.logo} alt="" width={20} height={20} />
                            </span>
                            <span className={styles.agentToolCopy}>
                              <strong>{provider.name}</strong>
                            </span>
                            <span
                              className={`${styles.agentToolCheck} ${enabled ? styles.agentToolCheckOn : ""}`}
                              aria-hidden="true"
                            >
                              <AnimatePresence initial={false}>
                                {enabled ? (
                                  <motion.svg
                                    key="check"
                                    width="12"
                                    height="12"
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    initial={reduceMotion ? false : { opacity: 0, scale: 0.65 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={reduceMotion ? undefined : { opacity: 0, scale: 0.65 }}
                                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                                  >
                                    <motion.path
                                      d="M3.4 8.2 L6.6 11.3 L12.6 4.4"
                                      stroke="currentColor"
                                      strokeWidth="2.2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      initial={reduceMotion ? false : { pathLength: 0 }}
                                      animate={{ pathLength: 1 }}
                                      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                                    />
                                  </motion.svg>
                                ) : null}
                              </AnimatePresence>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className={styles.agentCreateFooter}>
                  <p className={styles.agentCreateSummary}>
                    {agentFrequency === "Manual"
                      ? "Runs only when you start it."
                      : agentFrequency === "Hourly"
                        ? "Runs every hour."
                        : agentFrequency === "Daily"
                          ? `Runs daily at ${agentTime}.`
                          : `Runs ${agentDays.length > 0 ? agentDays.join(", ") : "no days selected"} at ${agentTime}.`}
                  </p>
                  <button
                    className={styles.agentCreateButton}
                    type="button"
                    disabled={!agentInstructions.trim()}
                    onClick={() => {
                      if (!agentName.trim() && agentInstructions.trim()) {
                        setAgentName(agentInstructions.trim().slice(0, 48));
                      }
                      setActiveTab("Playground");
                    }}
                  >
                    <span>Create agent</span>
                  </button>
                </div>
          </aside>
          </div>
        ) : activeItem === "Agents" ? (
          <div className={`${styles.agentsShell} ${agentsDetailOpen ? styles.agentsShellOpen : ""}`}>
            <div className={styles.agentsWorkspace}>
              <div className={styles.agentsIntro}>
                <p>Ten example agents ready to review. Select a row to inspect schedule, prompt, and recent runs.</p>
                <div className={styles.tableDensity} role="group" aria-label="Table row size">
                  <button
                    type="button"
                    className={tableDensity === "compact" ? styles.tableDensityActive : ""}
                    aria-pressed={tableDensity === "compact"}
                    onClick={() => setTableDensity("compact")}
                  >
                    Compact
                  </button>
                  <button
                    type="button"
                    className={tableDensity === "normal" ? styles.tableDensityActive : ""}
                    aria-pressed={tableDensity === "normal"}
                    onClick={() => setTableDensity("normal")}
                  >
                    Normal
                  </button>
                </div>
              </div>

              <div className={styles.agentsTableWrap}>
                <table
                  className={`${styles.agentsTable} ${tableDensity === "compact" ? styles.tableCompact : ""}`}
                >
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">Status</th>
                      <th scope="col">Schedule</th>
                      <th scope="col">Last run</th>
                      <th scope="col">Next run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exampleAgents.map((agent) => {
                      const isSelected = selectedAgentId === agent.id;
                      return (
                        <tr
                          className={`${styles.agentsTableRow} ${isSelected ? styles.agentsTableRowSelected : ""}`}
                          key={agent.id}
                          tabIndex={0}
                          aria-selected={isSelected}
                          onClick={() => setSelectedAgentId(agent.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedAgentId(agent.id);
                            }
                          }}
                        >
                          <td>
                            <div className={styles.agentsTableName}>
                              <strong>{agent.name}</strong>
                              <span>{agent.tools.join(" · ")}</span>
                            </div>
                          </td>
                          <td>
                            <span
                              className={`${styles.agentsStatus} ${
                                agent.status === "Active"
                                  ? styles.agentsStatusActive
                                  : agent.status === "Paused"
                                    ? styles.agentsStatusPaused
                                    : styles.agentsStatusDraft
                              }`}
                            >
                              {agent.status}
                            </span>
                          </td>
                          <td>{agent.schedule}</td>
                          <td>{agent.lastRun}</td>
                          <td>{agent.nextRun}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <aside
              className={`${styles.agentsDetailPanel} ${agentsDetailOpen ? styles.agentsDetailPanelOpen : ""}`}
              aria-label="Agent details"
              aria-hidden={!agentsDetailOpen}
              inert={!agentsDetailOpen}
            >
              {selectedAgent ? (
                <>
                  <div className={styles.agentsDetailHeader}>
                    <div>
                      <h2 id="agent-detail-title">{selectedAgent.name}</h2>
                      <span
                        className={`${styles.agentsStatus} ${
                          selectedAgent.status === "Active"
                            ? styles.agentsStatusActive
                            : selectedAgent.status === "Paused"
                              ? styles.agentsStatusPaused
                              : styles.agentsStatusDraft
                        }`}
                      >
                        {selectedAgent.status}
                      </span>
                    </div>
                    <button
                      className={styles.agentsDetailClose}
                      type="button"
                      aria-label="Close agent details"
                      onClick={() => setSelectedAgentId(null)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>

                  <div className={styles.agentsDetailBody}>
                    <section className={styles.agentsDetailSection}>
                      <h3>Schedule</h3>
                      <dl className={styles.agentsDetailMeta}>
                        <div>
                          <dt>Cadence</dt>
                          <dd>{selectedAgent.schedule}</dd>
                        </div>
                        <div>
                          <dt>Last run</dt>
                          <dd>{selectedAgent.lastRun}</dd>
                        </div>
                        <div>
                          <dt>Next run</dt>
                          <dd>{selectedAgent.nextRun}</dd>
                        </div>
                      </dl>
                    </section>

                    <section className={styles.agentsDetailSection}>
                      <h3>Tools</h3>
                      <div className={styles.agentsDetailTools}>
                        {selectedAgent.tools.map((tool) => (
                          <span key={tool}>{tool}</span>
                        ))}
                      </div>
                    </section>

                    <section className={styles.agentsDetailSection}>
                      <h3>Prompt</h3>
                      <p className={styles.agentsDetailPrompt}>{selectedAgent.prompt}</p>
                    </section>

                    <section className={styles.agentsDetailSection}>
                      <h3>Recent runs</h3>
                      {selectedAgent.runs.length > 0 ? (
                        <ul className={styles.agentsDetailRuns}>
                          {selectedAgent.runs.map((run) => (
                            <li key={run.id}>
                              <div>
                                <strong>{run.at}</strong>
                                <span>{run.result}</span>
                              </div>
                              <small>{run.duration}</small>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={styles.agentsDetailEmpty}>No runs yet.</p>
                      )}
                    </section>
                  </div>
                </>
              ) : null}
            </aside>
          </div>
        ) : activeItem === "Connections" ? (
          <ConnectionsWorkspace />
        ) : (
          <div className={styles.contentBody}>
            <p className={styles.contentEyebrow}>ALBERT DASH</p>
            <h2>{activeTab}</h2>
            <p className={styles.contentDescription}>
              Your {activeTab.toLowerCase()} workspace is ready. Choose a view from the tabs above to get started.
            </p>
          </div>
        )}
      </section>

      {albertPopupOpen ? (
        <div
          className={`${styles.popupBackdrop} ${albertPopupClosing ? styles.popupBackdropClosing : ""}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAlbertPopupClosing(true);
          }}
        >
          <section
            ref={albertPopupRef}
            className={`${styles.albertPopup} ${albertPopupClosing ? styles.albertPopupClosing : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="albert-popup-title"
            aria-describedby="albert-popup-description"
          >
            <button
              ref={popupCloseButtonRef}
              className={styles.popupClose}
              type="button"
              aria-label="Close Albert introduction"
              onClick={() => setAlbertPopupClosing(true)}
            >
              <Icon name="close" />
            </button>

            <div className={styles.popupIntro}>
              <span className={styles.popupMark}><Icon name="sparkle" /></span>
              <span className={styles.popupEyebrow}>ALBERT</span>
            </div>
            <h2 id="albert-popup-title">A clearer way to find your next step.</h2>
            <p id="albert-popup-description">
              Ask Albert about your activity, uncover what changed, and turn a question into an action in seconds.
            </p>

            <div className={styles.popupPreview} aria-hidden="true">
              <div className={styles.popupPreviewTopline}>
                <span>YOUR WORKSPACE</span>
                <span>NOW</span>
              </div>
              <div className={styles.popupInsight}>
                <span className={styles.popupInsightMark}><Icon name="sparkle" /></span>
                <p>“What should I focus on this week?”</p>
              </div>
              <div className={styles.popupInsightReply}>
                <span>Albert</span>
                <p>I found three priorities worth your attention.</p>
              </div>
            </div>

            <div className={styles.popupActions}>
              <button className={styles.popupSecondaryAction} type="button" onClick={() => setAlbertPopupClosing(true)}>
                Maybe later
              </button>
              <button className={styles.popupPrimaryAction} type="button" onClick={openAlbertChat}>
                <span>Open Albert</span>
                <Icon name="arrowUpRight" />
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
