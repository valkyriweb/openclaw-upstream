// Server HTTP probe tests cover readiness, health, disabled compat routes, and
// auth handling through the in-memory HTTP harness.
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";
import { withTempConfig } from "./test-temp-config.js";

type GatewayServerHarness = Parameters<typeof dispatchRequest>[0];
type GatewayRequestOptions = Parameters<typeof createRequest>[0];

async function sendGatewayRequest(server: GatewayServerHarness, options: GatewayRequestOptions) {
  const req = createRequest(options);
  const { res, getBody } = createResponse();
  await dispatchRequest(server, req, res);
  return { res, getBody };
}

describe("gateway OpenAI-compatible disabled HTTP routes", () => {
  it("returns 404 when compat endpoints are disabled", async () => {
    await withGatewayServer({
      prefix: "openai-compat-disabled",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        for (const path of ["/v1/chat/completions", "/v1/responses"]) {
          const { res, getBody } = await sendGatewayRequest(server, {
            path,
            method: "POST",
            headers: { "content-type": "application/json" },
          });

          expect(res.statusCode, path).toBe(404);
          expect(getBody(), path).toBe("Not Found");
        }
      },
    });
  });
});

describe("gateway probe endpoints", () => {
  it("returns detailed readiness payload for local /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/ready" });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ready: true, failing: [], uptimeMs: 45_000 });
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, {
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("returns detailed readiness payload for authenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-remote-authenticated",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, {
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          ready: false,
          failing: ["discord", "telegram"],
          uptimeMs: 8_000,
        });
      },
    });
  });

  it("re-resolves auth for remote /ready requests after shared auth rotation", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });
    let currentAuth = AUTH_TOKEN;

    await withGatewayServer({
      prefix: "probe-remote-rotated-auth",
      // `resolvedAuth` remains the static fallback; `getResolvedAuth` drives the rotated value.
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        getReadiness,
        getResolvedAuth: () => currentAuth,
      },
      run: async (server) => {
        const sendReady = async (authorization: string) => {
          const { res, getBody } = await sendGatewayRequest(server, {
            path: "/ready",
            remoteAddress: "10.0.0.8",
            host: "gateway.test",
            authorization,
          });
          return { statusCode: res.statusCode, body: JSON.parse(getBody()) };
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });

        currentAuth = {
          ...AUTH_TOKEN,
          token: "rotated-token",
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: { ready: false },
        });
        await expect(sendReady("Bearer rotated-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });
      },
    });
  });

  it("hides readiness details when trusted-proxy auth violates browser origin policy", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withTempConfig({
      prefix: "probe-remote-origin-rejected",
      cfg: {
        gateway: {
          trustedProxies: ["10.0.0.1"],
          controlUi: {
            allowedOrigins: ["https://control.example"],
          },
        },
      },
      run: async () => {
        await withGatewayServer({
          prefix: "probe-remote-origin-rejected-server",
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          overrides: {
            getReadiness,
          },
          run: async (server) => {
            const { res, getBody } = await sendGatewayRequest(server, {
              path: "/ready",
              remoteAddress: "10.0.0.1",
              host: "gateway.test",
              headers: {
                origin: "https://evil.example",
                forwarded: "for=203.0.113.10;proto=https;host=gateway.test",
                "x-forwarded-user": "user@example.com",
                "x-forwarded-proto": "https",
              },
            });

            expect(res.statusCode).toBe(503);
            expect(JSON.parse(getBody())).toEqual({ ready: false });
          },
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/ready" });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
    });
  });

  it("keeps /healthz shallow even when readiness checker reports failing channels", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 999,
    });

    await withGatewayServer({
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/healthz" });

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
      },
    });
  });

  it("serves /healthz before loading gateway config", async () => {
    const getRuntimeConfig = vi.fn(() => {
      throw new Error("config load blocked");
    });

    await withGatewayServer({
      prefix: "probe-healthz-before-config",
      resolvedAuth: AUTH_NONE,
      overrides: { getRuntimeConfig },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/healthz" });

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
        expect(getRuntimeConfig).not.toHaveBeenCalled();
      },
    });
  });

  it("serves probes before stalled request stages", async () => {
    const handleHooksRequest = vi.fn((): Promise<boolean> => new Promise(() => {}));
    const getReadiness = vi.fn(() => ({
      ready: true,
      failing: [],
      uptimeMs: 123,
    }));

    await withGatewayServer({
      prefix: "probe-before-stalled-stages",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness, handleHooksRequest },
      run: async (server) => {
        const healthReq = createRequest({ path: "/healthz" });
        const healthResponse = createResponse();
        await dispatchRequest(server, healthReq, healthResponse.res);

        expect(healthResponse.res.statusCode).toBe(200);
        expect(healthResponse.getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));

        const readyReq = createRequest({ path: "/readyz" });
        const readyResponse = createResponse();
        await dispatchRequest(server, readyReq, readyResponse.res);

        expect(readyResponse.res.statusCode).toBe(200);
        expect(JSON.parse(readyResponse.getBody())).toEqual({
          ready: true,
          failing: [],
          uptimeMs: 123,
        });
        expect(handleHooksRequest).not.toHaveBeenCalled();
      },
    });
  });

  // ISSUE-109: per-timer interval health surfaced via /readyz.intervals.
  it("surfaces intervals map on /readyz when the readiness checker emits it (Gap 2 / ISSUE-109)", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 30_000,
      eventLoop: {
        degraded: false,
        reasons: [],
        intervalMs: 30_000,
        delayP99Ms: 1,
        delayMaxMs: 2,
        utilization: 0.001,
        cpuCoreRatio: 0.002,
      },
      intervals: {
        tick: { intervalMs: 30_000, lastFiredAtMs: 1_700_000_000_000, missedTicks: 0 },
        healthRefresh: { intervalMs: 60_000, lastFiredAtMs: 1_700_000_000_000, missedTicks: 0 },
        dedupeCleanup: { intervalMs: 60_000, lastFiredAtMs: 1_700_000_000_000, missedTicks: 0 },
        mediaCleanup: { intervalMs: 3_600_000, lastFiredAtMs: 1_700_000_000_000, missedTicks: 0 },
        taskSweep: { intervalMs: 60_000, lastFiredAtMs: 1_700_000_000_000, missedTicks: 0 },
        channelHealthMonitor: {
          intervalMs: 300_000,
          lastFiredAtMs: 1_700_000_000_000,
          missedTicks: 0,
        },
      },
    });

    await withGatewayServer({
      prefix: "probe-readyz-intervals",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/readyz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(getBody());
        expect(body.intervals).toBeDefined();
        for (const name of [
          "tick",
          "healthRefresh",
          "dedupeCleanup",
          "mediaCleanup",
          "taskSweep",
          "channelHealthMonitor",
        ]) {
          expect(body.intervals[name]).toMatchObject({
            intervalMs: expect.any(Number),
            lastFiredAtMs: expect.any(Number),
            missedTicks: expect.any(Number),
          });
        }
        expect(body.eventLoop.degraded).toBe(false);
      },
    });
  });

  it("reflects readiness status on HEAD /readyz without a response body", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 5_000,
    });

    await withGatewayServer({
      prefix: "probe-readyz-head",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, {
          path: "/readyz",
          method: "HEAD",
        });

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });
});
