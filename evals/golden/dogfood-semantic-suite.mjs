import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const DOGFOOD_SEMANTIC_SUITE_VERSION = "albert-v1-m5-semantic-suite@3";

const primary = (rowRequirement, periods, inputContractDigest) => ({
  queryId: "primary",
  rowRequirement,
  periods,
  inputContractDigest,
});
const comparison = (rowRequirement, periods, inputContractDigest) => ({
  queryId: "comparison",
  rowRequirement,
  periods,
  inputContractDigest,
});
const period = (path, shape) => ({
  path,
  boundaryTimezone: "UTC",
  boundaryTime: "00:00:00.000",
  ...shape,
});
const singleRange = (shape) => [period(["time", "range"], shape)];
const compositeRanges = (shape) => [
  period(["queries", 0, "time", "range"], shape),
  period(["queries", 1, "time", "range"], shape),
];
const ref = (queryId, path) => ({ queryId, path });

export const DOGFOOD_SEMANTIC_SUITE_CASES = deepFreeze([
  {
    caseId: "sales-month-vs-last",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("nonempty", singleRange({ shape: "month-to-date", anchorPolicy: "collection" }), "5d5457927875329d82dac7e31d5a17b13b0ffc2c34b27ebbac6a1429f4427894")],
    rangeRelations: [],
  },
  {
    caseId: "sales-category",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("allow-empty", singleRange({ shape: "month-to-date", anchorPolicy: "collection" }), "79feb2b780432930bdd9e0cf04c8698ad738b99acf252c23a11b85f7ea4505ff")],
    rangeRelations: [],
  },
  {
    caseId: "sales-products-margin",
    kind: "golden",
    expectedState: "qualified",
    queries: [primary("allow-empty", singleRange({ shape: "quarter-to-date", anchorPolicy: "collection" }), "1edf1eb2715914b1a843dd770cce0cc1fdcd565f0386609c624fe6b794339f8f")],
    rangeRelations: [],
  },
  {
    caseId: "sales-aov-trend",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("allow-empty", singleRange({ shape: "rolling-calendar-months-inclusive", months: 6, anchorPolicy: "collection" }), "0459a2eb2494de9872f1f2bca93418f3e88ea1b1765da44146637b12386176eb")],
    rangeRelations: [],
  },
  {
    caseId: "sales-discount-location",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("allow-empty", singleRange({ shape: "full-calendar-month", anchorPolicy: "previous-calendar-month" }), "b361fcbeb7ff4bfa193c879d479a7d296f509aac84189c6e837f0c13b439dfdc")],
    rangeRelations: [],
  },
  {
    caseId: "sales-refund-rate",
    kind: "golden",
    expectedState: "verified",
    queries: [
      primary("nonempty", singleRange({ shape: "quarter-to-date", anchorPolicy: "collection" }), "03e5213c54e6eae4ca72445c5d99a7a4469c132e721315114393f5d24338c2b8"),
      comparison("nonempty", singleRange({ shape: "prior-quarter-like-for-like", anchorPolicy: "primary-calendar-shift" }), "0947fd01776becedc8f9915ca7d6f0ff9c45a9f9581d38ddb465f55759bc89cd"),
    ],
    rangeRelations: [{
      relation: "calendar-shift",
      months: -3,
      source: ref("primary", ["time", "range"]),
      target: ref("comparison", ["time", "range"]),
    }],
  },
  {
    caseId: "inventory-overstocked",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("allow-empty", singleRange({ shape: "rolling-days", days: 30, anchorPolicy: "collection" }), "789b0171f99c8823f17e3798282ec09c6dc7468395b009bc22e66c119c15c20b")],
    rangeRelations: [],
  },
  {
    caseId: "inventory-sell-through",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("nonempty", singleRange({ shape: "rolling-days", days: 30, anchorPolicy: "collection" }), "ebdf54f43b098117d0a9917912e2a473f4aec477b8ac4516fb09e93dd2862e2c")],
    rangeRelations: [],
  },
  {
    caseId: "inventory-out",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("allow-empty", singleRange({ shape: "rolling-days", days: 30, anchorPolicy: "collection" }), "68dc4c20340c7f53e19911cba9105189c18f1a680b73b0428375972efb22fd30")],
    rangeRelations: [],
  },
  {
    caseId: "inventory-dead",
    kind: "golden",
    expectedState: "qualified",
    queries: [primary("allow-empty", singleRange({ shape: "rolling-days", days: 90, anchorPolicy: "collection" }), "9bd5057d825fbe998a89ff5ffcc7459254d71844887e1928f9a1e3a9d48482be")],
    rangeRelations: [],
  },
  {
    caseId: "customers-new-returning",
    kind: "golden",
    expectedState: "qualified",
    queries: [primary("nonempty", singleRange({ shape: "month-to-date", anchorPolicy: "collection" }), "568eaf38ac41993c311ef20418ecb520483daac9562589981b2b1cba7cfff395")],
    rangeRelations: [],
  },
  {
    caseId: "customers-lapsed",
    kind: "golden",
    expectedState: "qualified",
    queries: [primary("nonempty", singleRange({ shape: "minimum-history-days", days: 180, anchorPolicy: "collection" }), "887a1b99cd120784ba4d1782914cee489b9465f731a52719241cac3d3b6cd729")],
    rangeRelations: [],
  },
  {
    caseId: "customers-repeat",
    kind: "golden",
    expectedState: "qualified",
    queries: [primary("nonempty", singleRange({ shape: "year-to-date", anchorPolicy: "collection" }), "375025a982c6ff77105dd1270d46ca40dc60d8bb6629ee20cf62470e278328d9")],
    rangeRelations: [],
  },
  {
    caseId: "workforce-roster-vs-worked",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("allow-empty", singleRange({ shape: "rolling-days", days: 7, startWeekday: 0, anchorPolicy: "previous-complete-week" }), "0a5195addee75681b79b6ba09940a2d1dadda052817f4361ccba9343bc410fa3")],
    rangeRelations: [],
  },
  {
    caseId: "workforce-labour-percent",
    kind: "composite",
    expectedState: "qualified",
    queries: [primary("allow-empty", compositeRanges({ shape: "quarter-to-date", anchorPolicy: "collection" }), "30ebb5d209707d7b576ebd5e13c8bc9de7d71da2ca8c607778f5d6ba25d9394e")],
    rangeRelations: [{
      relation: "equal",
      source: ref("primary", ["queries", 0, "time", "range"]),
      target: ref("primary", ["queries", 1, "time", "range"]),
    }],
  },
  {
    caseId: "workforce-sales-hour",
    kind: "composite",
    expectedState: "verified",
    queries: [primary("allow-empty", compositeRanges({ shape: "month-to-date", anchorPolicy: "collection" }), "5ac92277b8bad299ba070a9a44eadaa91d7f333f4db53b158f40c2a465999f9b")],
    rangeRelations: [{
      relation: "equal",
      source: ref("primary", ["queries", 0, "time", "range"]),
      target: ref("primary", ["queries", 1, "time", "range"]),
    }],
  },
  {
    caseId: "finance-gst",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("nonempty", singleRange({ shape: "quarter-to-date", anchorPolicy: "collection" }), "6fc7158a67941167d6db3fc0c4234320bb828a4f19293a5270e8cf4a890dd96f")],
    rangeRelations: [],
  },
  {
    caseId: "finance-receivables",
    kind: "golden",
    expectedState: "verified",
    queries: [primary("nonempty", singleRange({ shape: "month-to-date", anchorPolicy: "collection" }), "29e25fa672ada9174af2c603b1e56e1aa0c79049f0e56351048d84ea9efb9bc1")],
    rangeRelations: [],
  },
  {
    caseId: "finance-cash-pos",
    kind: "composite",
    expectedState: "qualified",
    queries: [primary("allow-empty", compositeRanges({ shape: "calendar-day", anchorPolicy: "previous-calendar-day" }), "b61cf136dcb6f44c65f647e781945c903646886f39050a86a6cc2e1faaa7be08")],
    rangeRelations: [{
      relation: "equal",
      source: ref("primary", ["queries", 0, "time", "range"]),
      target: ref("primary", ["queries", 1, "time", "range"]),
    }],
  },
  {
    caseId: "reconcile-bank",
    kind: "composite",
    expectedState: "qualified",
    queries: [primary("allow-empty", compositeRanges({ shape: "calendar-day", startWeekday: 2, anchorPolicy: "most-recent-weekday" }), "a8384fdbf4ea1fa89d67c3cd375c7c0301d05f8a068762a2037808e885a972ed")],
    rangeRelations: [{
      relation: "equal",
      source: ref("primary", ["queries", 0, "time", "range"]),
      target: ref("primary", ["queries", 1, "time", "range"]),
    }],
  },
]);

// This reviewed digest is intentionally pinned rather than derived for export.
// Changing any query, period, relation, or row contract requires a new suite
// version and digest in the same review.
export const DOGFOOD_SEMANTIC_SUITE_DIGEST = "b0c4d8c281883094cae2382de45e838c95659f44c247e0b0859e5f11e28bc3f5";

export function dogfoodSemanticInputContractDigest(input, periods) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input), "Dogfood semantic input must be an object.");
  assert.ok(Array.isArray(periods) && periods.length > 0, "Dogfood semantic periods must be code-owned and nonempty.");
  const periodByPath = new Map(periods.map((contract) => [pathKey(contract.path), contract]));
  assert.equal(periodByPath.size, periods.length, "Dogfood semantic period paths must be unique.");
  const matchedPaths = new Set();
  const contractedInput = inputContract(input, [], periodByPath, matchedPaths);
  assert.equal(matchedPaths.size, periods.length, "Dogfood semantic input is missing a reviewed period path.");
  return createHash("sha256").update(canonicalJson({ input: contractedInput, periods })).digest("hex");
}

export function dogfoodSemanticCollectionAnchor(nowInput) {
  const now = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput);
  assert.ok(Number.isFinite(now.getTime()), "Dogfood semantic collection clock is invalid.");
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )).toISOString();
}

export function validateDogfoodSemanticPlanAtCollectionAnchor(plan, collectionAnchor) {
  assert.ok(plan && typeof plan === "object" && !Array.isArray(plan), "Dogfood semantic plan must be an object.");
  assert.ok(Array.isArray(plan.cases), "Dogfood semantic plan cases must be an array.");
  assert.equal(plan.cases.length, DOGFOOD_SEMANTIC_SUITE_CASES.length, "Dogfood semantic plan case count changed.");
  const anchor = parseBoundaryInstant(collectionAnchor, {
    boundaryTimezone: "UTC",
    boundaryTime: "00:00:00.000",
  });
  for (const [caseIndex, registryEntry] of DOGFOOD_SEMANTIC_SUITE_CASES.entries()) {
    const testCase = plan.cases[caseIndex];
    assert.equal(testCase?.caseId, registryEntry.caseId, "Dogfood semantic collection case order changed.");
    assert.ok(Array.isArray(testCase.queries), `Dogfood semantic case ${registryEntry.caseId} has no queries.`);
    assert.equal(testCase.queries.length, registryEntry.queries.length, `Dogfood semantic case ${registryEntry.caseId} query count changed.`);
    const inputsByQueryId = new Map();
    for (const [queryIndex, queryContract] of registryEntry.queries.entries()) {
      const query = testCase.queries[queryIndex];
      assert.equal(query?.queryId, queryContract.queryId, `Dogfood semantic case ${registryEntry.caseId} query order changed.`);
      assert.equal(
        dogfoodSemanticInputContractDigest(query.input, queryContract.periods),
        queryContract.inputContractDigest,
        `Dogfood semantic query ${registryEntry.caseId}/${queryContract.queryId} input contract changed.`,
      );
      inputsByQueryId.set(queryContract.queryId, query.input);
      for (const periodContract of queryContract.periods) {
        const actual = getPath(query.input, periodContract.path);
        assert.ok(actual && typeof actual === "object" && !Array.isArray(actual), "Dogfood semantic anchored period is missing.");
        if (periodContract.anchorPolicy === "primary-calendar-shift") {
          const hasOwningRelation = registryEntry.rangeRelations.some((relation) => (
            relation.relation === "calendar-shift" &&
            relation.target.queryId === queryContract.queryId &&
            pathKey(relation.target.path) === pathKey(periodContract.path)
          ));
          assert.ok(hasOwningRelation, "Dogfood semantic shifted period has no code-owned primary relation.");
          continue;
        }
        if (periodContract.shape === "minimum-history-days" && periodContract.anchorPolicy === "collection") {
          assert.equal(actual.to, collectionAnchor, "Reviewed history period is stale relative to collection.");
          continue;
        }
        assert.deepEqual(
          actual,
          anchoredPeriod(periodContract, anchor.date),
          `Reviewed semantic period is stale or shortened for ${registryEntry.caseId}/${queryContract.queryId}.`,
        );
      }
    }
    validateDogfoodSemanticRangeRelations(inputsByQueryId, registryEntry.rangeRelations);
  }
  return true;
}

export function validateDogfoodSemanticRangeRelations(inputsByQueryId, relations) {
  assert.ok(inputsByQueryId instanceof Map, "Dogfood semantic relation inputs must be a Map.");
  assert.ok(Array.isArray(relations), "Dogfood semantic range relations must be an array.");
  for (const relation of relations) {
    const source = rangeAtReference(inputsByQueryId, relation.source);
    const target = rangeAtReference(inputsByQueryId, relation.target);
    if (relation.relation === "equal") {
      assert.deepEqual(target, source, "Reviewed semantic periods that must align are different.");
      continue;
    }
    assert.equal(relation.relation, "calendar-shift", "Dogfood semantic range relation is unsupported.");
    assert.ok(Number.isInteger(relation.months), "Dogfood semantic calendar shift must use whole months.");
    const expected = {
      type: "absolute",
      from: shiftInstantCalendarMonths(source.from, relation.months),
      to: shiftInstantCalendarMonths(source.to, relation.months),
    };
    assert.deepEqual(target, expected, "Reviewed comparison period is not calendar-aligned to its primary period.");
  }
}

function anchoredPeriod(contract, anchorDate) {
  const includedDate = addCalendarDays(anchorDate, -1);
  let from;
  let to;
  switch (contract.anchorPolicy) {
    case "collection":
      to = anchorDate;
      if (contract.shape === "month-to-date") {
        from = { year: includedDate.year, month: includedDate.month, day: 1 };
      } else if (contract.shape === "quarter-to-date") {
        from = {
          year: includedDate.year,
          month: Math.floor((includedDate.month - 1) / 3) * 3 + 1,
          day: 1,
        };
      } else if (contract.shape === "year-to-date") {
        from = { year: includedDate.year, month: 1, day: 1 };
      } else if (contract.shape === "rolling-days") {
        from = addCalendarDays(anchorDate, -contract.days);
      } else if (contract.shape === "rolling-calendar-months-inclusive") {
        from = addCalendarDays(addCalendarMonths(anchorDate, -contract.months), -1);
      } else {
        assert.fail(`Unsupported collection-anchored period shape ${String(contract.shape)}.`);
      }
      break;
    case "previous-calendar-month": {
      const currentMonthStart = { year: includedDate.year, month: includedDate.month, day: 1 };
      from = addCalendarMonths(currentMonthStart, -1);
      to = currentMonthStart;
      break;
    }
    case "previous-complete-week": {
      assert.ok(Number.isInteger(contract.startWeekday), "Reviewed weekly period has no start weekday.");
      const currentWeekStart = addCalendarDays(
        includedDate,
        -((weekday(includedDate) - contract.startWeekday + 7) % 7),
      );
      from = addCalendarDays(currentWeekStart, -7);
      to = currentWeekStart;
      break;
    }
    case "previous-calendar-day":
      from = addCalendarDays(anchorDate, -2);
      to = addCalendarDays(anchorDate, -1);
      break;
    case "most-recent-weekday": {
      assert.ok(Number.isInteger(contract.startWeekday), "Reviewed weekday period has no weekday.");
      from = addCalendarDays(
        includedDate,
        -((weekday(includedDate) - contract.startWeekday + 7) % 7),
      );
      to = addCalendarDays(from, 1);
      break;
    }
    default:
      assert.fail(`Unsupported dogfood semantic anchor policy ${String(contract.anchorPolicy)}.`);
  }
  return {
    type: "absolute",
    from: `${formatDate(from)}T${contract.boundaryTime}Z`,
    to: `${formatDate(to)}T${contract.boundaryTime}Z`,
  };
}

function inputContract(value, path, periodByPath, matchedPaths) {
  const contract = periodByPath.get(pathKey(path));
  if (contract) {
    validatePeriod(value, contract);
    matchedPaths.add(pathKey(path));
    return { $dynamicAbsoluteRange: periodShapeContract(contract) };
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => inputContract(child, [...path, index], periodByPath, matchedPaths));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      inputContract(child, [...path, key], periodByPath, matchedPaths),
    ]));
  }
  return value;
}

function validatePeriod(value, contract) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Reviewed semantic period must be an object.");
  assert.deepEqual(Object.keys(value).sort(), ["from", "to", "type"], "Reviewed semantic period shape is invalid.");
  assert.equal(value.type, "absolute", "Reviewed semantic periods must remain absolute ranges.");
  const from = parseBoundaryInstant(value.from, contract);
  const to = parseBoundaryInstant(value.to, contract);
  assert.ok(to.instant > from.instant, "Reviewed semantic period must end after it starts.");
  assert.equal(from.wallClock, to.wallClock, "Reviewed semantic period boundaries must use the same wall-clock cutoff.");
  const days = dayOrdinal(to.date) - dayOrdinal(from.date);
  if (contract.startWeekday !== undefined) {
    assert.equal(weekday(from.date), contract.startWeekday, "Reviewed semantic period starts on the wrong calendar weekday.");
  }
  switch (contract.shape) {
    case "month-to-date": {
      assert.equal(from.date.day, 1, "Reviewed month-to-date period must start on day one.");
      const maximum = addCalendarMonths(from.date, 1);
      assert.ok(days > 0 && compareDate(to.date, maximum) <= 0, "Reviewed month-to-date period exceeds one calendar month.");
      break;
    }
    case "quarter-to-date": {
      assert.equal(from.date.day, 1, "Reviewed quarter-to-date period must start on day one.");
      assert.ok([1, 4, 7, 10].includes(from.date.month), "Reviewed quarter-to-date period must start on a calendar quarter boundary.");
      const maximum = addCalendarMonths(from.date, 3);
      assert.ok(days > 0 && compareDate(to.date, maximum) <= 0, "Reviewed quarter-to-date period exceeds one calendar quarter.");
      break;
    }
    case "prior-quarter-like-for-like": {
      assert.equal(from.date.day, 1, "Reviewed prior-quarter period must start on day one.");
      assert.ok([1, 4, 7, 10].includes(from.date.month), "Reviewed prior-quarter period must start on a calendar quarter boundary.");
      const maximum = addCalendarMonths(from.date, 3);
      assert.ok(days > 0 && compareDate(to.date, maximum) <= 0, "Reviewed prior-quarter period exceeds one calendar quarter.");
      break;
    }
    case "year-to-date": {
      assert.equal(from.date.month, 1, "Reviewed year-to-date period must start in January.");
      assert.equal(from.date.day, 1, "Reviewed year-to-date period must start on day one.");
      const maximum = { year: from.date.year + 1, month: 1, day: 1 };
      assert.ok(days > 0 && compareDate(to.date, maximum) <= 0, "Reviewed year-to-date period exceeds one calendar year.");
      break;
    }
    case "full-calendar-month":
      assert.equal(from.date.day, 1, "Reviewed full-month period must start on day one.");
      assert.deepEqual(to.date, addCalendarMonths(from.date, 1), "Reviewed full-month period must end on the next month boundary.");
      break;
    case "rolling-calendar-months-inclusive":
      assert.deepEqual(
        to.date,
        addCalendarDays(addCalendarMonths(from.date, contract.months), 1),
        "Reviewed rolling-month period has the wrong inclusive calendar duration.",
      );
      break;
    case "rolling-days":
      assert.equal(days, contract.days, "Reviewed rolling-day period has the wrong calendar duration.");
      break;
    case "minimum-history-days":
      assert.ok(days >= contract.days, "Reviewed history period is shorter than its governed minimum.");
      break;
    case "calendar-day":
      assert.equal(days, 1, "Reviewed single-day period must cover exactly one calendar day.");
      break;
    default:
      assert.fail(`Unsupported dogfood semantic period shape ${String(contract.shape)}.`);
  }
}

function parseBoundaryInstant(value, contract) {
  assert.ok(typeof value === "string", "Reviewed semantic period boundary must be a string.");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  assert.ok(match, "Reviewed semantic period boundary must be a canonical ISO-8601 instant.");
  const [, year, month, day, hour, minute, second, millisecond, offset] = match;
  assert.equal(contract.boundaryTimezone, "UTC", "Only the reviewed UTC period boundary policy is supported.");
  assert.equal(offset, "Z", "Reviewed semantic period boundary must use UTC.");
  const wallClock = `${hour}:${minute}:${second}.${millisecond}`;
  assert.equal(wallClock, contract.boundaryTime, "Reviewed semantic period boundary uses the wrong cutoff time.");
  const date = { year: Number(year), month: Number(month), day: Number(day) };
  assertValidDate(date);
  const instant = Date.parse(value);
  assert.ok(Number.isFinite(instant), "Reviewed semantic period boundary is invalid.");
  return { date, instant, wallClock };
}

function rangeAtReference(inputsByQueryId, reference) {
  assert.ok(reference && typeof reference === "object", "Dogfood semantic range reference is invalid.");
  const input = inputsByQueryId.get(reference.queryId);
  assert.ok(input, `Dogfood semantic query ${String(reference.queryId)} is missing.`);
  const range = getPath(input, reference.path);
  assert.ok(range && typeof range === "object" && !Array.isArray(range), "Dogfood semantic relation range is missing.");
  return range;
}

function getPath(value, path) {
  assert.ok(Array.isArray(path), "Dogfood semantic period path must be an array.");
  return path.reduce((current, segment) => current?.[segment], value);
}

function shiftInstantCalendarMonths(value, months) {
  const parsed = parseBoundaryInstant(value, { boundaryTimezone: "UTC", boundaryTime: "00:00:00.000" });
  const shifted = addCalendarMonths(parsed.date, months);
  return `${formatDate(shifted)}T${parsed.wallClock}Z`;
}

function periodShapeContract(contract) {
  return Object.fromEntries(Object.entries(contract).filter(([key]) => key !== "path"));
}

function pathKey(path) {
  assert.ok(Array.isArray(path), "Dogfood semantic period path must be an array.");
  return canonicalJson(path);
}

function assertValidDate(value) {
  assert.ok(Number.isInteger(value.year) && value.year >= 1970 && value.year <= 9999, "Reviewed semantic period year is invalid.");
  assert.ok(Number.isInteger(value.month) && value.month >= 1 && value.month <= 12, "Reviewed semantic period month is invalid.");
  assert.ok(Number.isInteger(value.day) && value.day >= 1 && value.day <= daysInMonth(value.year, value.month), "Reviewed semantic period day is invalid.");
}

function addCalendarMonths(value, months) {
  assert.ok(Number.isInteger(months), "Calendar month shift must be an integer.");
  const monthIndex = value.year * 12 + value.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  return { year, month, day: Math.min(value.day, daysInMonth(year, month)) };
}

function addCalendarDays(value, days) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function dayOrdinal(value) {
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 86_400_000);
}

function weekday(value) {
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
}

function compareDate(left, right) {
  return dayOrdinal(left) - dayOrdinal(right);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDate(value) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "Dogfood suite contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  assert.ok(value && typeof value === "object", "Dogfood suite contains an unsupported value.");
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const computedDigest = createHash("sha256").update(canonicalJson({
  suiteVersion: DOGFOOD_SEMANTIC_SUITE_VERSION,
  cases: DOGFOOD_SEMANTIC_SUITE_CASES,
})).digest("hex");

assert.equal(
  computedDigest,
  DOGFOOD_SEMANTIC_SUITE_DIGEST,
  "The reviewed dogfood semantic suite changed without a new pinned version and digest.",
);
