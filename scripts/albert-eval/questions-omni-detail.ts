import type { EvalQuestion } from "./questions.js";

/**
 * Omni answer-detail battery: short questions whose good answer is short but
 * complete. The owner asked "when did we last sell a trace" (2026-09-24) and
 * got a date, one model and a price: not who bought it, who served them, or
 * whether that was even the last Trace (it was not; the query had narrowed
 * "trace" to one model). Each of these is a casual one-liner where the facts
 * an owner asks next belong in the first reply.
 *
 * Read the answers beside the `expect` notes; score shape with
 * scripts/albert-eval/style-metrics.mts (the style battery guards length).
 */
export const OMNI_DETAIL_QUESTIONS: readonly EvalQuestion[] = [
  {
    id: "DT-01",
    tier: "easy",
    scope: "lightspeed",
    surface: "products",
    pattern: "cold",
    question: "when did we last sell a trace",
    expect: "Every Trace model counts, not one variant. Names the date, the exact model, who bought it (or a walk-in) and who served them, and the price against list; one anchor such as the Trace before it or this year's count.",
    format: "prose",
  },
  {
    id: "DT-02",
    tier: "easy",
    scope: "lightspeed",
    surface: "sales",
    pattern: "cold",
    question: "What was our biggest sale last month?",
    expect: "The sale's date and total, what was in it, who bought it and who served them; one anchor such as how it compares with a typical sale.",
    format: "prose",
  },
  {
    id: "DT-03",
    tier: "easy",
    scope: "lightspeed",
    surface: "products",
    pattern: "cold",
    question: "who bought the most expensive bike this year?",
    expect: "The customer by name (or a walk-in), the bike, the date and what it went for against list.",
    format: "prose",
  },
  {
    id: "DT-04",
    tier: "easy",
    scope: "lightspeed",
    surface: "products",
    pattern: "cold",
    question: "last time we sold a helmet?",
    expect: "Any helmet counts. Date, which helmet, customer and staff member, price against list; how often helmets sell.",
    format: "prose",
  },
  {
    id: "DT-05",
    tier: "easy",
    scope: "lightspeed",
    surface: "sales",
    pattern: "cold",
    question: "how much did we take on saturday",
    expect: "The takings, an anchor (the Saturday before or a typical Saturday), and what drove the day: transactions, the biggest sale or the leading category.",
    format: "prose",
  },
  {
    id: "DT-06",
    tier: "easy",
    scope: "lightspeed",
    surface: "customers",
    pattern: "cold",
    question: "who's our best customer this year",
    expect: "Names the customer, their spend and visits, and what they buy; excludes walk-in or unnamed sales as a customer.",
    format: "prose",
  },
  {
    id: "DT-07",
    tier: "easy",
    scope: "lightspeed",
    surface: "workshop",
    pattern: "cold",
    question: "what was the last workshop job we checked in?",
    expect: "The job's check-in date, the customer, what it was for, and its status or value.",
    format: "prose",
  },
  {
    id: "DT-08",
    tier: "easy",
    scope: "lightspeed",
    surface: "products",
    pattern: "cold",
    question: "did we sell any e-bikes last month?",
    expect: "Yes or no first; how many, which models and the revenue; an anchor against the month before.",
    format: "prose",
  },
];
