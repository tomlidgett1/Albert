import assert from "node:assert/strict";
import test from "node:test";

import {
  describeSchedule,
  describeScheduleDays,
  formatPhoneForDisplay,
  formatTimeOfDay,
  isValidTimezone,
  normaliseScheduleDays,
  scheduledRunMessage,
  toScheduledTask,
} from "../../services/scheduled/src/contracts.ts";
import {
  formatInZone,
  nextScheduledRunAt,
  zonedOffsetMs,
  zonedParts,
  zonedTimeToUtc,
} from "../../services/scheduled/src/next-run.ts";

const MELBOURNE = "Australia/Melbourne";

test("zoned parts and offsets read the local wall clock of an instant", () => {
  // 2026-09-01T00:00Z is 10:00 AEST (UTC+10) on Tuesday 1 September.
  const parts = zonedParts(new Date("2026-09-01T00:00:00Z"), MELBOURNE);
  assert.deepEqual({ ...parts }, { year: 2026, month: 9, day: 1, hour: 10, minute: 0, second: 0, weekday: 2 });
  assert.equal(zonedOffsetMs(new Date("2026-09-01T00:00:00Z"), MELBOURNE), 10 * 3_600_000);
  // After the first Sunday in October the zone is AEDT (UTC+11).
  assert.equal(zonedOffsetMs(new Date("2026-10-10T00:00:00Z"), MELBOURNE), 11 * 3_600_000);
  assert.equal(zonedOffsetMs(new Date("2026-09-01T00:00:00Z"), "Australia/Perth"), 8 * 3_600_000);
  assert.equal(zonedOffsetMs(new Date("2026-09-01T00:00:00Z"), "UTC"), 0);
});

test("a local wall time converts back to the right instant on both sides of daylight saving", () => {
  assert.equal(
    zonedTimeToUtc({ year: 2026, month: 9, day: 2, hour: 9, minute: 0 }, MELBOURNE).toISOString(),
    "2026-09-01T23:00:00.000Z",
  );
  // Melbourne clocks go forward at 02:00 on Sunday 4 October 2026: 09:00 that day is UTC+11.
  assert.equal(
    zonedTimeToUtc({ year: 2026, month: 10, day: 4, hour: 9, minute: 0 }, MELBOURNE).toISOString(),
    "2026-10-03T22:00:00.000Z",
  );
  // New York falls back on 1 November 2026 at 02:00 EDT: 01:30 happens twice; the first reading wins.
  assert.equal(
    zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York").toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  // New York springs forward on 8 March 2026 at 02:00 EST: 02:30 never happens; land the same offset past the gap.
  assert.equal(
    zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York").toISOString(),
    "2026-03-08T07:30:00.000Z",
  );
});

test("next run is the next allowed weekday at the local time, strictly after the reference instant", () => {
  const daily = { timeOfDay: "09:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const, timezone: MELBOURNE };
  // 10:00 AEST on 1 Sep is past 09:00, so the next slot is 09:00 on 2 Sep (23:00Z on 1 Sep).
  assert.equal(nextScheduledRunAt(daily, new Date("2026-09-01T00:00:00Z"))?.toISOString(), "2026-09-01T23:00:00.000Z");
  // 08:00 AEST on 2 Sep is before 09:00: later the same day.
  assert.equal(nextScheduledRunAt(daily, new Date("2026-09-01T22:00:00Z"))?.toISOString(), "2026-09-01T23:00:00.000Z");
  // Exactly on the slot is not "after" it.
  assert.equal(nextScheduledRunAt(daily, new Date("2026-09-01T23:00:00Z"))?.toISOString(), "2026-09-02T23:00:00.000Z");
  assert.equal(nextScheduledRunAt(daily, new Date("2026-09-01T22:59:59.500Z"))?.toISOString(), "2026-09-01T23:00:00.000Z");
  // Across the October change the same 09:00 wall time moves an hour earlier in UTC.
  assert.equal(nextScheduledRunAt(daily, new Date("2026-10-03T00:00:00Z"))?.toISOString(), "2026-10-03T22:00:00.000Z");

  const weekdays = { timeOfDay: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] as const, timezone: MELBOURNE };
  // Friday 4 Sep 10:00 AEST → Monday 7 Sep 09:00 AEST.
  assert.equal(nextScheduledRunAt(weekdays, new Date("2026-09-04T00:00:00Z"))?.toISOString(), "2026-09-06T23:00:00.000Z");
  const mondays = { timeOfDay: "08:30", days: ["mon"] as const, timezone: MELBOURNE };
  // Monday 7 Sep 08:00 AEST → the same morning at 08:30.
  assert.equal(nextScheduledRunAt(mondays, new Date("2026-09-06T22:00:00Z"))?.toISOString(), "2026-09-06T22:30:00.000Z");
  // Monday 7 Sep 09:00 AEST → the following Monday.
  assert.equal(nextScheduledRunAt(mondays, new Date("2026-09-06T23:00:00Z"))?.toISOString(), "2026-09-13T22:30:00.000Z");

  // Other zones and the year boundary.
  const perth = { timeOfDay: "09:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const, timezone: "Australia/Perth" };
  assert.equal(nextScheduledRunAt(perth, new Date("2026-09-01T00:00:00Z"))?.toISOString(), "2026-09-01T01:00:00.000Z");
  const utc = { timeOfDay: "23:30", days: ["thu"] as const, timezone: "UTC" };
  assert.equal(nextScheduledRunAt(utc, new Date("2026-12-31T23:45:00Z"))?.toISOString(), "2027-01-07T23:30:00.000Z");
});

test("an invalid schedule has no next run", () => {
  assert.equal(nextScheduledRunAt({ timeOfDay: "9:00", days: ["mon"], timezone: MELBOURNE }, new Date()), null);
  assert.equal(nextScheduledRunAt({ timeOfDay: "09:00", days: [], timezone: MELBOURNE }, new Date()), null);
  assert.equal(nextScheduledRunAt({ timeOfDay: "09:00", days: ["mon"], timezone: "Mars/Olympus" }, new Date()), null);
  assert.equal(isValidTimezone("Australia/Melbourne"), true);
  assert.equal(isValidTimezone("Not/AZone"), false);
  assert.equal(isValidTimezone(""), false);
});

test("schedule copy reads naturally", () => {
  assert.equal(formatTimeOfDay("09:00"), "9:00 am");
  assert.equal(formatTimeOfDay("17:30"), "5:30 pm");
  assert.equal(formatTimeOfDay("00:15"), "12:15 am");
  assert.equal(formatTimeOfDay("12:00"), "12:00 pm");
  assert.equal(describeScheduleDays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), "Every day");
  assert.equal(describeScheduleDays(["fri", "mon", "tue", "wed", "thu"]), "Weekdays");
  assert.equal(describeScheduleDays(["sat", "sun"]), "Weekends");
  assert.equal(describeScheduleDays(["mon"]), "Mondays");
  assert.equal(describeScheduleDays(["wed", "mon", "fri"]), "Mon, Wed and Fri");
  assert.equal(describeSchedule({ timeOfDay: "09:00", days: ["mon", "wed"], timezone: MELBOURNE }), "Mon and Wed at 9:00 am");
  assert.deepEqual(normaliseScheduleDays(["sun", "mon", "mon", "fri", "nope"]), ["mon", "fri", "sun"]);
  assert.equal(formatPhoneForDisplay("+61414187820"), "+61 414 187 820");
  assert.equal(formatPhoneForDisplay("+16502831814"), "+1 (650) 283-1814");
  assert.equal(formatPhoneForDisplay("+441234567890"), "+441234567890");
  assert.match(formatInZone(new Date("2026-09-01T23:00:00Z"), MELBOURNE), /Wed.*2 Sep.*9:00/u);
  const message = scheduledRunMessage({ title: "Yesterday's sales overview", prompt: "How did sales go yesterday?" });
  assert.match(message, /^How did sales go yesterday\?\n\n\(Scheduled update "Yesterday's sales overview"/u);
});

test("task JSON from the control plane normalises into the shared shape", () => {
  const task = toScheduledTask({
    taskId: "01KZN20VTX2EWW1TQ2AA3MCPW6",
    title: "Yesterday's sales overview",
    requestText: "send me a message every morning at 9am with an overview of yesterday's sales",
    prompt: "How did sales go yesterday?",
    timeOfDay: "09:00",
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    timezone: MELBOURNE,
    phone: "+61414187820",
    enabled: true,
    nextRunAt: "2026-09-01T23:00:00+00:00",
    lastRunAt: null,
    createdAt: "2026-09-01T10:00:00+00:00",
    updatedAt: "2026-09-01T10:00:00+00:00",
    lastRun: null,
    recentRuns: null,
  });
  assert.deepEqual([...task.days], ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.equal(task.lastRun, null);
  assert.deepEqual([...task.recentRuns], []);
});
