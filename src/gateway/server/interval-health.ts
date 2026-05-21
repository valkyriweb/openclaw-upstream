/**
 * Per-timer interval health registry (Gap 2 / ISSUE-109).
 *
 * The gateway runs several long-lived `setInterval`-driven maintenance loops
 * (tick, healthRefresh, dedupeCleanup, mediaCleanup, taskSweep,
 * channelHealthMonitor). Until ISSUE-109 their freshness was only inferable
 * from the proxy of `/readyz uptimeMs` strictly increasing.
 *
 * This module gives each loop a tiny "I just fired" hook (`recordFire(name)`)
 * and exposes a JSON-friendly snapshot consumed by `/readyz` and
 * `lab-heartbeat-check.sh`. `missedTicks` is computed lazily on read so the
 * hot path stays a single integer assignment per fire.
 */
export type IntervalHealthSnapshot = {
  intervalMs: number;
  lastFiredAtMs: number | null;
  missedTicks: number;
};

export type IntervalHealthRegistry = {
  /**
   * Declare (or update the cadence of) a known interval. Safe to call
   * before the first fire; the snapshot will report `lastFiredAtMs: null`
   * and `missedTicks: 0` until the loop fires for the first time.
   */
  register(name: string, intervalMs: number): void;
  /**
   * Stamp this interval as having just fired. Call from inside the
   * `setInterval` callback (and from `setTimeout`-driven loops that
   * functionally behave the same way).
   */
  recordFire(name: string, atMs?: number): void;
  /**
   * Read every registered interval's current health. Caller may pin `now`
   * for deterministic tests. Empty result when nothing has been registered.
   */
  snapshot(now?: number): Record<string, IntervalHealthSnapshot>;
  /**
   * True if any registered interval has missed >= `threshold` ticks. Used
   * by readiness to flip `eventLoop.degraded` regardless of perf_hooks
   * health (a stuck setInterval can still leave the event loop responsive).
   */
  hasMissedTicks(threshold: number, now?: number): boolean;
};

type InternalEntry = {
  intervalMs: number;
  lastFiredAtMs: number | null;
};

/** Well-known interval names surfaced on `/readyz.intervals`. */
export const GATEWAY_INTERVAL_NAMES = [
  "tick",
  "healthRefresh",
  "dedupeCleanup",
  "mediaCleanup",
  "taskSweep",
  "channelHealthMonitor",
] as const;
export type GatewayIntervalName = (typeof GATEWAY_INTERVAL_NAMES)[number];

export function createIntervalHealthRegistry(): IntervalHealthRegistry {
  const entries = new Map<string, InternalEntry>();

  function compute(entry: InternalEntry, now: number): IntervalHealthSnapshot {
    const lastFiredAtMs = entry.lastFiredAtMs;
    if (lastFiredAtMs === null || entry.intervalMs <= 0) {
      return { intervalMs: entry.intervalMs, lastFiredAtMs, missedTicks: 0 };
    }
    const elapsed = now - lastFiredAtMs;
    const missedTicks = elapsed <= 0 ? 0 : Math.max(0, Math.floor(elapsed / entry.intervalMs) - 1);
    return { intervalMs: entry.intervalMs, lastFiredAtMs, missedTicks };
  }

  return {
    register(name, intervalMs) {
      const existing = entries.get(name);
      if (existing) {
        existing.intervalMs = intervalMs;
        return;
      }
      entries.set(name, { intervalMs, lastFiredAtMs: null });
    },
    recordFire(name, atMs = Date.now()) {
      const entry = entries.get(name);
      if (entry) {
        entry.lastFiredAtMs = atMs;
        return;
      }
      // Fire-before-register tolerated: stamp now, default intervalMs=0 until
      // an explicit `register()` call sets the cadence.
      entries.set(name, { intervalMs: 0, lastFiredAtMs: atMs });
    },
    snapshot(now = Date.now()) {
      const out: Record<string, IntervalHealthSnapshot> = {};
      for (const [name, entry] of entries) {
        out[name] = compute(entry, now);
      }
      return out;
    },
    hasMissedTicks(threshold, now = Date.now()) {
      if (threshold <= 0) {
        return entries.size > 0;
      }
      for (const entry of entries.values()) {
        if (compute(entry, now).missedTicks >= threshold) {
          return true;
        }
      }
      return false;
    },
  };
}
