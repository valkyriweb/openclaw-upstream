// Gateway readiness checker for channel health and startup sidecar state.
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";
import type { IntervalHealthRegistry, IntervalHealthSnapshot } from "./interval-health.js";

/** Snapshot returned by the gateway readiness probe. */
export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
  /**
   * Per-timer interval health (Gap 2 / ISSUE-109). Present whenever the
   * gateway boot wires the interval-health registry; absent on older
   * images so consumers must treat it as optional.
   */
  intervals?: Record<string, IntervalHealthSnapshot>;
};

/** Threshold for flipping eventLoop.degraded on stuck setInterval loops. */
export const READINESS_MISSED_TICKS_DEGRADED_THRESHOLD = 3;

/** Function form used by HTTP readiness endpoints and tests. */
export type ReadinessChecker = () => ReadinessResult;

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  return health.reason === "not-running" && accountSnapshot.restartPending === true;
}

/** Create a cached readiness checker over channel runtime health. */
export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  getStartupPending?: () => boolean;
  getStartupPendingReason?: () => string | undefined;
  getGatewayDraining?: () => boolean;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  /**
   * Returns the gateway-wide interval-health registry. When wired, /readyz
   * surfaces a per-timer `intervals` map and flips `eventLoop.degraded` to
   * true whenever any registered timer has missed >= 3 ticks.
   */
  getIntervalHealth?: () => IntervalHealthRegistry | undefined;
  shouldSkipChannelReadiness?: () => boolean;
  cacheTtlMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;
    if (deps.getStartupPending?.()) {
      const reason = deps.getStartupPendingReason?.() ?? "startup-sidecars";
      return withReadinessExtras(
        { ready: false, failing: [reason], uptimeMs },
        deps.getEventLoopHealth,
        deps.getIntervalHealth,
        now,
      );
    }
    if (deps.getGatewayDraining?.()) {
      return withReadinessExtras(
        { ready: false, failing: ["gateway-draining"], uptimeMs },
        deps.getEventLoopHealth,
        deps.getIntervalHealth,
        now,
      );
    }
    if (deps.shouldSkipChannelReadiness?.()) {
      return withReadinessExtras(
        { ready: true, failing: [], uptimeMs },
        deps.getEventLoopHealth,
        deps.getIntervalHealth,
        now,
      );
    }
    if (cachedState && now - cachedAt < cacheTtlMs) {
      return withReadinessExtras(
        { ...cachedState, uptimeMs },
        deps.getEventLoopHealth,
        deps.getIntervalHealth,
        now,
      );
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const failing: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
          failing.push(channelId);
          break;
        }
      }
    }

    cachedAt = now;
    cachedState = { ready: failing.length === 0, failing };
    return withReadinessExtras(
      { ...cachedState, uptimeMs },
      deps.getEventLoopHealth,
      deps.getIntervalHealth,
      now,
    );
  };
}

function withReadinessExtras(
  result: ReadinessResult,
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined,
  getIntervalHealth?: () => IntervalHealthRegistry | undefined,
  now: number = Date.now(),
): ReadinessResult {
  const eventLoop = getEventLoopHealth?.();
  const registry = getIntervalHealth?.();
  let merged: ReadinessResult = result;
  if (registry) {
    const intervals = registry.snapshot(now);
    if (Object.keys(intervals).length > 0) {
      merged = { ...merged, intervals };
    }
    if (eventLoop && registry.hasMissedTicks(READINESS_MISSED_TICKS_DEGRADED_THRESHOLD, now)) {
      merged = { ...merged, eventLoop: { ...eventLoop, degraded: true } };
      return merged;
    }
  }
  if (eventLoop) {
    return { ...merged, eventLoop };
  }
  return merged;
}
