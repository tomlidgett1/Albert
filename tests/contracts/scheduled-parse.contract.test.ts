import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";

import {
  acceptScheduleDraft,
  heuristicDays,
  heuristicPrompt,
  heuristicSchedule,
  heuristicTimeOfDay,
  heuristicTimezone,
  heuristicTitle,
  parseScheduleRequest,
  SCHEDULE_PARSE_MODEL,
} from "../../services/scheduled/src/parse.ts";

const MELBOURNE = "Australia/Melbourne";
const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

test("the heuristic reading finds the time of day in the owner's words", () => {
  assert.deepEqual({ ...heuristicTimeOfDay("every morning at 9am") }, { timeOfDay: "09:00", assumed: false });
  assert.deepEqual({ ...heuristicTimeOfDay("at 9:30 pm on Fridays") }, { timeOfDay: "21:30", assumed: false });
  assert.deepEqual({ ...heuristicTimeOfDay("12pm sharp") }, { timeOfDay: "12:00", assumed: false });
  assert.deepEqual({ ...heuristicTimeOfDay("12:15am") }, { timeOfDay: "00:15", assumed: false });
  assert.deepEqual({ ...heuristicTimeOfDay("at 17:00 every day") }, { timeOfDay: "17:00", assumed: false });
  assert.deepEqual({ ...heuristicTimeOfDay("9 in the morning") }, { timeOfDay: "09:00", assumed: false });
  assert.deepEqual({ ...heuristicTimeOfDay("text me at 5 with the day's takings") }, { timeOfDay: "17:00", assumed: true });
  assert.deepEqual({ ...heuristicTimeOfDay("text me at 9 with yesterday's takings") }, { timeOfDay: "09:00", assumed: true });
  assert.deepEqual({ ...heuristicTimeOfDay("every morning, sales from yesterday") }, { timeOfDay: "09:00", assumed: true });
  assert.deepEqual({ ...heuristicTimeOfDay("a Friday evening wrap of the week") }, { timeOfDay: "18:00", assumed: true });
  assert.deepEqual({ ...heuristicTimeOfDay("after we close, the day's sales") }, { timeOfDay: "17:30", assumed: true });
  assert.deepEqual({ ...heuristicTimeOfDay("sales vs wages") }, { timeOfDay: "09:00", assumed: true });
});

test("the heuristic reading finds the days", () => {
  assert.deepEqual([...heuristicDays("every morning at 9am").days], ALL_DAYS);
  assert.deepEqual([...heuristicDays("weekdays at 5pm").days], ["mon", "tue", "wed", "thu", "fri"]);
  assert.deepEqual([...heuristicDays("Monday to Friday at 8").days], ["mon", "tue", "wed", "thu", "fri"]);
  assert.deepEqual([...heuristicDays("every Monday at 8:30am").days], ["mon"]);
  assert.deepEqual([...heuristicDays("on Wednesdays and Fridays").days], ["wed", "fri"]);
  assert.deepEqual([...heuristicDays("weekends only").days], ["sat", "sun"]);
  assert.equal(heuristicDays("sales vs wages").assumed, true);
  assert.deepEqual([...heuristicDays("sales vs wages").days], ALL_DAYS);
  assert.equal(heuristicTimezone("9am Brisbane time", MELBOURNE), "Australia/Brisbane");
  assert.equal(heuristicTimezone("9am AWST", MELBOURNE), "Australia/Perth");
  assert.equal(heuristicTimezone("9am", MELBOURNE), MELBOURNE);
});

test("the standing question survives with the delivery and cadence words removed", () => {
  assert.equal(
    heuristicPrompt("send me a message every morning at 9am with an overview of the sales performance from yesterday"),
    "An overview of the sales performance from yesterday.",
  );
  assert.equal(
    heuristicPrompt("Every Monday at 8:30am text me last week's sales vs the week before"),
    "Last week's sales vs the week before.",
  );
  assert.equal(heuristicPrompt("weekdays at 5pm: wages vs sales for the day"), "Wages vs sales for the day.");
  assert.equal(heuristicPrompt("How were sales yesterday?"), "How were sales yesterday?");
  assert.equal(heuristicTitle("An overview of the sales performance from yesterday."), "The sales performance from yesterday");
  assert.equal(heuristicTitle("How were sales yesterday?"), "Sales yesterday");
  assert.equal(heuristicTitle(""), "Scheduled report");
});

test("the heuristic schedule is complete and says what it assumed", () => {
  const explicit = heuristicSchedule("send me a message every morning at 9am with an overview of the sales performance from yesterday", MELBOURNE);
  assert.equal(explicit.timeOfDay, "09:00");
  assert.deepEqual([...explicit.days], ALL_DAYS);
  assert.equal(explicit.timezone, MELBOURNE);
  assert.equal(explicit.note, "");
  assert.equal(explicit.source, "heuristic");

  const vague = heuristicSchedule("sales vs wages", MELBOURNE);
  assert.equal(vague.timeOfDay, "09:00");
  assert.match(vague.note, /9:00 am was assumed and every day was assumed/u);
  assert.equal(vague.prompt, "Sales vs wages.");
});

test("model drafts are accepted only when valid, with the zone checked against Intl", () => {
  const base = {
    title: "Yesterday's sales overview",
    prompt: "Give me an overview of yesterday's sales performance against the same day last week.",
    timeOfDay: "09:00",
    days: ["mon", "mon", "sun", "tue"] as const,
    timezone: null,
    note: "",
  };
  const accepted = acceptScheduleDraft({ ...base, days: [...base.days] }, MELBOURNE);
  assert.ok(accepted);
  assert.deepEqual([...accepted.days], ["mon", "tue", "sun"]);
  assert.equal(accepted.timezone, MELBOURNE);
  assert.equal(accepted.source, "model");

  const zoned = acceptScheduleDraft({ ...base, days: ["fri"], timezone: "Australia/Brisbane" }, MELBOURNE);
  assert.equal(zoned?.timezone, "Australia/Brisbane");
  const badZone = acceptScheduleDraft({ ...base, days: ["fri"], timezone: "Australia/Nowhere" }, MELBOURNE);
  assert.equal(badZone?.timezone, MELBOURNE);
  assert.match(badZone?.note ?? "", /was not recognised/u);

  assert.equal(acceptScheduleDraft({ ...base, days: [], timeOfDay: "09:00" }, MELBOURNE), null);
  assert.equal(acceptScheduleDraft({ ...base, days: ["mon"], timeOfDay: "9am" }, MELBOURNE), null);
  assert.equal(acceptScheduleDraft({ ...base, days: ["mon"], prompt: "short" }, MELBOURNE), null);
  const punctuated = acceptScheduleDraft({ ...base, days: ["mon"], title: "Sales overview." }, MELBOURNE);
  assert.equal(punctuated?.title, "Sales overview");
});

function fakeClient(reply: () => string | Error): OpenAI {
  return {
    responses: {
      create: async () => {
        const value = reply();
        if (value instanceof Error) throw value;
        return { output_text: value };
      },
    },
  } as unknown as OpenAI;
}

test("parsing prefers the model's reading and falls back to the heuristic when it is unusable", async () => {
  const text = "send me a message every morning at 9am with an overview of the sales performance from yesterday";
  const modelled = await parseScheduleRequest({
    text,
    defaultTimezone: MELBOURNE,
    client: fakeClient(() => JSON.stringify({
      title: "Yesterday's sales overview",
      prompt: "How did sales perform yesterday compared with the same day last week, by store and category?",
      timeOfDay: "09:00",
      days: ALL_DAYS,
      timezone: null,
      note: "",
    })),
  });
  assert.equal(modelled.source, "model");
  assert.equal(modelled.title, "Yesterday's sales overview");
  assert.match(modelled.prompt, /same day last week/u);
  assert.equal(SCHEDULE_PARSE_MODEL, "gpt-5.6-luna");

  const broken = await parseScheduleRequest({ text, defaultTimezone: MELBOURNE, client: fakeClient(() => "not json") });
  assert.equal(broken.source, "heuristic");
  assert.equal(broken.timeOfDay, "09:00");

  const failed = await parseScheduleRequest({ text, defaultTimezone: MELBOURNE, client: fakeClient(() => new Error("provider down")) });
  assert.equal(failed.source, "heuristic");

  const noKey = await parseScheduleRequest({ text, defaultTimezone: MELBOURNE });
  assert.equal(noKey.source, "heuristic");
  assert.equal(noKey.prompt, "An overview of the sales performance from yesterday.");
});
