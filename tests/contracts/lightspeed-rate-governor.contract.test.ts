import assert from "node:assert/strict";
import test from "node:test";
import {
  LightspeedRateGovernor,
  RateGovernorRegistry,
} from "../../connectors/lightspeed-r/rate-governor.js";

/** Deterministic clock so every assertion below is about behaviour, not timing. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const headers = (level: string, drip: string): Record<string, string> => ({
  "X-LS-API-Bucket-Level": level,
  "X-LS-API-Drip-Rate": drip,
});

test("burst capacity is spendable immediately, then the drip rate governs", () => {
  const c = clock();
  // Large burst window so this test isolates the bucket limiter.
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 1_000 });

  // Capacity 60 minus 2 units of headroom = 58 immediate GETs.
  for (let i = 0; i < 58; i += 1) {
    assert.equal(g.delayFor(1), 0, `request ${i + 1} should not wait`);
    g.commit(1);
  }

  // The 59th must wait for one unit to drip at 1/second.
  assert.equal(g.delayFor(1), 1_000);

  c.advance(1_000);
  assert.equal(g.delayFor(1), 0, "a full second of drip releases exactly one unit");
});

test("a faster off-peak drip rate is used, not ignored", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 1_000 });

  // Vendor reports an off-peak bucket: bigger and draining 1.5x faster.
  g.observe(headers("90/90", "1.5"));
  assert.equal(g.state.capacity, 90);
  assert.equal(g.state.dripRate, 1.5);

  // Level 90 against a usable 88 means a deficit of 3 units at 1.5/s = 2000ms.
  // A fixed sleep(1000) implementation would either stall or 429 here.
  assert.equal(g.delayFor(1), 2_000);
});

test("the header is authoritative and overrides local accounting", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 1_000 });

  for (let i = 0; i < 20; i += 1) g.commit(1);
  assert.ok(g.state.level >= 20, "local model tracked the spend");

  // Another worker drained the shared bucket; the server says so.
  g.observe(headers("5/60", "1"));
  assert.equal(g.state.level, 5, "model snapped to the server's accounting");
  assert.equal(g.state.calibrated, true);
});

test("count=1 is charged at ten units, not one", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 1_000 });

  g.commit(10);
  assert.equal(Math.round(g.state.level), 10);

  // 58 usable units: after 10, a 10-unit request still fits, a 5th does not.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(g.delayFor(10), 0);
    g.commit(10);
  }
  assert.ok(g.delayFor(10) > 0, "the sixth count=1 request must wait");
});

test("burst rejection halves the learned window cap and waits exactly one second", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 8 });

  const first = g.classifyThrottle("429 Too Many Requests: burst rate limit exceeded");
  assert.equal(first.kind, "burst");
  assert.equal(first.waitMs, 1_000, "the docs prescribe a one second back-off");
  assert.equal(g.state.burstWindowCap, 4);

  g.classifyThrottle("burst rate limit exceeded");
  assert.equal(g.state.burstWindowCap, 2, "the cap keeps halving until it stops being rejected");
});

test("the learned burst cap never collapses to zero", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 2 });
  for (let i = 0; i < 10; i += 1) g.classifyThrottle("burst rate limit exceeded");
  assert.ok(g.state.burstWindowCap >= 1, "a zero cap would deadlock the fetcher");
});

test("the burst window actually throttles within one second", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 3 });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(g.delayFor(1), 0);
    g.commit(1);
  }
  const wait = g.delayFor(1);
  assert.ok(wait > 0 && wait <= 1_000, `fourth request in the window must wait, got ${wait}`);

  c.advance(1_000);
  assert.equal(g.delayFor(1), 0, "a new window opens");
});

test("bucket exhaustion is classified separately from a burst rejection", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 1_000 });

  g.observe(headers("60/60", "1"));
  const verdict = g.classifyThrottle("429 Rate Limit Exceeded");
  assert.equal(verdict.kind, "bucket");
  assert.ok(verdict.waitMs >= 3_000, "a full bucket needs the deficit to drain, not one second");
});

test("a malformed header cannot corrupt the model or hang a worker", () => {
  const c = clock();
  const g = new LightspeedRateGovernor({ now: c.now, initialBurstWindowCap: 1_000 });
  const before = g.state;

  g.observe({ "X-LS-API-Bucket-Level": "not/a/number", "X-LS-API-Drip-Rate": "abc" });
  assert.deepEqual(g.state, before, "garbage is ignored rather than absorbed");

  g.observe(headers("999999/1", "0.0001"));
  assert.ok(g.delayFor(1) <= 60_000, "a computed wait is always bounded");
});

test("governors are shared per connection so concurrent workers cannot starve each other", () => {
  const registry = new RateGovernorRegistry({ initialBurstWindowCap: 1_000 });
  const a = registry.for("conn-1");
  const b = registry.for("conn-1");
  const other = registry.for("conn-2");

  assert.equal(a, b, "the same connection must resolve to one governor");
  assert.notEqual(a, other, "separate connections hold separate buckets");

  for (let i = 0; i < 58; i += 1) a.commit(1);
  assert.ok(b.delayFor(1) > 0, "spend through one handle is visible through the other");
  assert.equal(other.delayFor(1), 0, "an unrelated connection is unaffected");
});
