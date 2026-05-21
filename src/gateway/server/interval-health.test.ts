import { describe, expect, it } from "vitest";
import { createIntervalHealthRegistry, GATEWAY_INTERVAL_NAMES } from "./interval-health.js";

describe("createIntervalHealthRegistry", () => {
  it("reports a registered interval with no fires as null/0", () => {
    const r = createIntervalHealthRegistry();
    r.register("tick", 30_000);
    expect(r.snapshot(1_000)).toEqual({
      tick: { intervalMs: 30_000, lastFiredAtMs: null, missedTicks: 0 },
    });
  });

  it("records fires and computes missedTicks lazily", () => {
    const r = createIntervalHealthRegistry();
    r.register("healthRefresh", 60_000);
    r.recordFire("healthRefresh", 1_000_000);

    // Immediately after fire, no missed ticks.
    expect(r.snapshot(1_000_000).healthRefresh).toEqual({
      intervalMs: 60_000,
      lastFiredAtMs: 1_000_000,
      missedTicks: 0,
    });

    // 1 interval elapsed without a follow-up fire -> still 0 missed (the next
    // tick is "due now", not "missed").
    expect(r.snapshot(1_000_000 + 60_000).healthRefresh.missedTicks).toBe(0);

    // 2 intervals elapsed -> 1 missed.
    expect(r.snapshot(1_000_000 + 2 * 60_000).healthRefresh.missedTicks).toBe(1);

    // 5 intervals elapsed -> 4 missed.
    expect(r.snapshot(1_000_000 + 5 * 60_000).healthRefresh.missedTicks).toBe(4);
  });

  it("re-registering keeps existing fire timestamp but updates intervalMs", () => {
    const r = createIntervalHealthRegistry();
    r.register("tick", 1_000);
    r.recordFire("tick", 5_000);
    r.register("tick", 2_000);
    expect(r.snapshot(5_000).tick).toEqual({
      intervalMs: 2_000,
      lastFiredAtMs: 5_000,
      missedTicks: 0,
    });
  });

  it("tolerates recordFire before register (intervalMs defaults to 0)", () => {
    const r = createIntervalHealthRegistry();
    r.recordFire("orphan", 42);
    expect(r.snapshot(42).orphan).toEqual({
      intervalMs: 0,
      lastFiredAtMs: 42,
      missedTicks: 0,
    });
  });

  it("hasMissedTicks(threshold) flips true when any timer crosses the bar", () => {
    const r = createIntervalHealthRegistry();
    r.register("tick", 1_000);
    r.recordFire("tick", 0);
    r.register("dedupeCleanup", 1_000);
    r.recordFire("dedupeCleanup", 0);
    expect(r.hasMissedTicks(3, 2_000)).toBe(false);
    expect(r.hasMissedTicks(3, 4_500)).toBe(true);
    expect(r.hasMissedTicks(10, 4_500)).toBe(false);
  });

  it("exports the six well-known gateway interval names in declaration order", () => {
    expect(GATEWAY_INTERVAL_NAMES).toEqual([
      "tick",
      "healthRefresh",
      "dedupeCleanup",
      "mediaCleanup",
      "taskSweep",
      "channelHealthMonitor",
    ]);
  });
});
