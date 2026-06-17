import type { GatewayEventLoopHealth } from "./event-loop-health.js";
import type { ReadinessChecker } from "./readiness.js";

/**
 * Gateway-side metric counters consumed by the `/metrics` Prometheus-text
 * endpoint (Gap 1 / ISSUE-108 of docs/prds/openclaw-lab-heartbeat-cron-surfaces.md
 * § 5). Counter values are kept in-process only — push to OTLP via
 * diagnostics-otel is unaffected.
 *
 * `incRequest` / `incError` fire from the gateway HTTP request lifecycle.
 * `incChannelHealthTick` fires from the channel-health monitor's interval
 * callback (Gap 2 instrumentation also feeds this counter).
 */
export type GatewayMetricsCounters = {
  incRequest: () => void;
  incError: () => void;
  incChannelHealthTick: () => void;
  snapshot: () => GatewayMetricsCounterSnapshot;
};

export type GatewayMetricsCounterSnapshot = {
  requestsTotal: number;
  errorsTotal: number;
  channelHealthTicksTotal: number;
};

export function createGatewayMetricsCounters(): GatewayMetricsCounters {
  let requestsTotal = 0;
  let errorsTotal = 0;
  let channelHealthTicksTotal = 0;
  return {
    incRequest: () => {
      requestsTotal += 1;
    },
    incError: () => {
      errorsTotal += 1;
    },
    incChannelHealthTick: () => {
      channelHealthTicksTotal += 1;
    },
    snapshot: () => ({ requestsTotal, errorsTotal, channelHealthTicksTotal }),
  };
}

/** `text/plain; version=0.0.4` per the Prometheus exposition format spec. */
export const GATEWAY_METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

type RenderInput = {
  counters: GatewayMetricsCounters;
  getReadiness?: ReadinessChecker;
  getCronJobCount?: () => number;
  /** Override `process.uptime()` for deterministic tests. */
  uptimeSeconds?: () => number;
  /**
   * Optional eventloop-delay percentile reader. Returns delay in milliseconds.
   * When absent, p50 / p99 metrics fall back to `eventLoop.delayP99Ms` and 0.
   */
  getEventLoopDelayPercentileMs?: (percentile: number) => number | undefined;
};

/**
 * Renders the gateway `/metrics` endpoint body. Hand-rolled Prometheus text
 * format (no prom-client dependency). Required metrics per § 5 Gap 1:
 *
 *   process_uptime_seconds
 *   nodejs_eventloop_lag_p50_seconds
 *   nodejs_eventloop_lag_p99_seconds
 *   openclaw_requests_total
 *   openclaw_errors_total
 *   openclaw_cron_jobs_total
 *   openclaw_channel_health_ticks_total
 *
 * All metrics are low-cardinality and contain no message-body, recipient, or
 * media-path data.
 */
export function renderGatewayMetrics(input: RenderInput): string {
  const counters = input.counters.snapshot();
  const eventLoop = safeEventLoopHealth(input.getReadiness);
  const uptimeSec = input.uptimeSeconds ? input.uptimeSeconds() : process.uptime();
  const p50Ms = readPercentileMs(input.getEventLoopDelayPercentileMs, 50);
  const p99Ms =
    readPercentileMs(input.getEventLoopDelayPercentileMs, 99) ?? eventLoop?.delayP99Ms ?? 0;
  const cronJobsTotal = safeCount(input.getCronJobCount);

  const lines: string[] = [];
  metric(
    lines,
    "process_uptime_seconds",
    "gauge",
    "Process uptime in seconds.",
    formatNumber(uptimeSec),
  );
  metric(
    lines,
    "nodejs_eventloop_lag_p50_seconds",
    "gauge",
    "Event-loop delay p50 in seconds (from the gateway's perf_hooks monitor).",
    formatNumber((p50Ms ?? 0) / 1000),
  );
  metric(
    lines,
    "nodejs_eventloop_lag_p99_seconds",
    "gauge",
    "Event-loop delay p99 in seconds (from the gateway's perf_hooks monitor).",
    formatNumber(p99Ms / 1000),
  );
  metric(
    lines,
    "openclaw_requests_total",
    "counter",
    "Total HTTP requests handled by the gateway since boot.",
    String(counters.requestsTotal),
  );
  metric(
    lines,
    "openclaw_errors_total",
    "counter",
    "Total HTTP responses the gateway emitted with status >= 500 since boot.",
    String(counters.errorsTotal),
  );
  metric(
    lines,
    "openclaw_cron_jobs_total",
    "gauge",
    "Number of persisted cron jobs currently registered in the gateway scheduler.",
    String(cronJobsTotal),
  );
  metric(
    lines,
    "openclaw_channel_health_ticks_total",
    "counter",
    "Total channel-health monitor ticks observed since gateway boot.",
    String(counters.channelHealthTicksTotal),
  );
  return `${lines.join("\n")}\n`;
}

function metric(out: string[], name: string, kind: string, help: string, value: string): void {
  out.push(`# HELP ${name} ${help}`);
  out.push(`# TYPE ${name} ${kind}`);
  out.push(`${name} ${value}`);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number.isInteger(value) ? value.toString() : value.toFixed(6);
}

function readPercentileMs(
  reader: ((percentile: number) => number | undefined) | undefined,
  percentile: number,
): number | undefined {
  if (!reader) {
    return undefined;
  }
  try {
    const value = reader(percentile);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeCount(provider?: () => number): number {
  if (!provider) {
    return 0;
  }
  try {
    const value = provider();
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function safeEventLoopHealth(getReadiness?: ReadinessChecker): GatewayEventLoopHealth | undefined {
  if (!getReadiness) {
    return undefined;
  }
  try {
    return getReadiness().eventLoop;
  } catch {
    return undefined;
  }
}
