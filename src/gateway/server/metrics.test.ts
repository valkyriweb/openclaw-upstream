import { describe, expect, it } from "vitest";
import {
  createGatewayMetricsCounters,
  GATEWAY_METRICS_CONTENT_TYPE,
  renderGatewayMetrics,
} from "./metrics.js";

describe("createGatewayMetricsCounters", () => {
  it("starts every counter at zero", () => {
    const counters = createGatewayMetricsCounters();
    expect(counters.snapshot()).toEqual({
      requestsTotal: 0,
      errorsTotal: 0,
      channelHealthTicksTotal: 0,
    });
  });

  it("increments each counter independently", () => {
    const counters = createGatewayMetricsCounters();
    counters.incRequest();
    counters.incRequest();
    counters.incError();
    counters.incChannelHealthTick();
    counters.incChannelHealthTick();
    counters.incChannelHealthTick();
    expect(counters.snapshot()).toEqual({
      requestsTotal: 2,
      errorsTotal: 1,
      channelHealthTicksTotal: 3,
    });
  });
});

describe("renderGatewayMetrics", () => {
  it("emits all seven required series in Prometheus text format", () => {
    const counters = createGatewayMetricsCounters();
    counters.incRequest();
    counters.incRequest();
    counters.incError();
    counters.incChannelHealthTick();
    const body = renderGatewayMetrics({
      counters,
      uptimeSeconds: () => 123.4,
      getCronJobCount: () => 5,
      getEventLoopDelayPercentileMs: (p) => (p === 50 ? 1 : p === 99 ? 50 : 0),
    });
    expect(body).toContain("process_uptime_seconds 123.400000");
    expect(body).toContain("nodejs_eventloop_lag_p50_seconds 0.001000");
    expect(body).toContain("nodejs_eventloop_lag_p99_seconds 0.05");
    expect(body).toContain("openclaw_requests_total 2");
    expect(body).toContain("openclaw_errors_total 1");
    expect(body).toContain("openclaw_cron_jobs_total 5");
    expect(body).toContain("openclaw_channel_health_ticks_total 1");
    // Each series must carry HELP + TYPE preamble.
    expect(body.match(/^# HELP /gm)?.length).toBe(7);
    expect(body.match(/^# TYPE /gm)?.length).toBe(7);
    expect(body.endsWith("\n")).toBe(true);
  });

  it("falls back to /readyz eventLoop.delayP99Ms when no percentile reader is wired", () => {
    const counters = createGatewayMetricsCounters();
    const body = renderGatewayMetrics({
      counters,
      uptimeSeconds: () => 7,
      getReadiness: () => ({
        ready: true,
        failing: [],
        uptimeMs: 7000,
        eventLoop: {
          degraded: false,
          reasons: [],
          intervalMs: 30_000,
          delayP99Ms: 12,
          delayMaxMs: 14,
          utilization: 0.01,
          cpuCoreRatio: 0.02,
        },
      }),
    });
    expect(body).toContain("nodejs_eventloop_lag_p50_seconds 0");
    expect(body).toContain("nodejs_eventloop_lag_p99_seconds 0.012");
  });

  it("returns 0 for cron job count when no provider is wired", () => {
    const counters = createGatewayMetricsCounters();
    const body = renderGatewayMetrics({ counters, uptimeSeconds: () => 0 });
    expect(body).toContain("openclaw_cron_jobs_total 0");
  });

  it("swallows provider exceptions and emits 0", () => {
    const counters = createGatewayMetricsCounters();
    const body = renderGatewayMetrics({
      counters,
      uptimeSeconds: () => 1,
      getCronJobCount: () => {
        throw new Error("cron service offline");
      },
      getReadiness: () => {
        throw new Error("readiness offline");
      },
      getEventLoopDelayPercentileMs: () => {
        throw new Error("monitor offline");
      },
    });
    expect(body).toContain("openclaw_cron_jobs_total 0");
    expect(body).toContain("nodejs_eventloop_lag_p99_seconds 0");
  });

  it("advertises text/plain; version=0.0.4 as the content type", () => {
    expect(GATEWAY_METRICS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
