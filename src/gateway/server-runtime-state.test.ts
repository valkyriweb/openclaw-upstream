/**
 * Gateway runtime state construction tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginSessionExtensionRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginChannelRegistry,
  pinActivePluginSessionExtensionRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  releasePinnedPluginSessionExtensionRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

function createRegistryWithRoute(path: string) {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path,
    auth: "plugin",
    match: "exact",
    handler: () => true,
    pluginId: "demo",
    source: "test",
  });
  return registry;
}

describe("createGatewayRuntimeState", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    releasePinnedPluginChannelRegistry();
    releasePinnedPluginSessionExtensionRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("exposes gateway metrics counters", async () => {
    const startupRegistry = createRegistryWithRoute("/startup");

    const runtimeState = await createGatewayRuntimeState({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 0,
      controlUiEnabled: false,
      controlUiBasePath: "/",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      resolvedAuth: {} as never,
      getResolvedAuth: () => ({}) as never,
      hooksConfig: () => null,
      getHookClientIpConfig: () => ({}) as never,
      pluginRegistry: startupRegistry,
      deps: {} as never,
      log: { info: () => {}, warn: () => {} },
      logHooks: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      logPlugins: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });

    runtimeState.metricsCounters.incRequest();
    runtimeState.metricsCounters.incError();
    runtimeState.metricsCounters.incChannelHealthTick();

    expect(runtimeState.metricsCounters.snapshot()).toEqual({
      requestsTotal: 1,
      errorsTotal: 1,
      channelHealthTicksTotal: 1,
    });
  });

  it("releases post-bootstrap repinned plugin registries on cleanup", async () => {
    const startupRegistry = createRegistryWithRoute("/startup");
    const loadedRegistry = createRegistryWithRoute("/loaded");
    const fallbackRegistry = createRegistryWithRoute("/fallback");

    setActivePluginRegistry(startupRegistry);
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry);

    pinActivePluginHttpRouteRegistry(loadedRegistry);
    pinActivePluginSessionExtensionRegistry(loadedRegistry);
    pinActivePluginChannelRegistry(loadedRegistry);
    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(loadedRegistry);
    expect(getActivePluginSessionExtensionRegistry()).toBe(loadedRegistry);
    expect(getActivePluginChannelRegistry()).toBe(loadedRegistry);

    runtimeState.releasePluginRouteRegistry();

    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(startupRegistry);
    expect(getActivePluginSessionExtensionRegistry()).toBe(startupRegistry);
    expect(getActivePluginChannelRegistry()).toBe(startupRegistry);
  });
});
