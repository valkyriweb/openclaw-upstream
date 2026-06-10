import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPiRpcArgv,
  clearPiProcess,
  dispatchPiRpcJsonlChunk,
  getOrCreatePiProcess,
} from "./session-binding.js";

describe("dispatchPiRpcJsonlChunk", () => {
  it("splits only on LF so Unicode line separators inside JSON strings survive", () => {
    const events: Record<string, unknown>[] = [];
    const listeners = new Set<(event: Record<string, unknown>) => void>([
      (event) => events.push(event),
    ]);
    const state = { buffer: "" };

    dispatchPiRpcJsonlChunk(
      state,
      JSON.stringify({ type: "message_update", text: "alpha\u2028beta\u2029gamma" }) + "\n",
      listeners,
    );

    expect(events).toEqual([{ type: "message_update", text: "alpha\u2028beta\u2029gamma" }]);
    expect(state.buffer).toBe("");
  });

  it("buffers partial JSONL chunks until LF arrives", () => {
    const events: Record<string, unknown>[] = [];
    const listeners = new Set<(event: Record<string, unknown>) => void>([
      (event) => events.push(event),
    ]);
    const state = { buffer: "" };

    dispatchPiRpcJsonlChunk(state, '{"type":"response"', listeners);
    dispatchPiRpcJsonlChunk(state, ',"success":true}\r\n', listeners);

    expect(events).toEqual([{ type: "response", success: true }]);
    expect(state.buffer).toBe("");
  });

  it("keeps dispatching after malformed JSONL lines and counts parse errors", () => {
    const events: Record<string, unknown>[] = [];
    const listeners = new Set<(event: Record<string, unknown>) => void>([
      (event) => events.push(event),
    ]);
    const state: { buffer: string; parseErrors?: number } = { buffer: "" };

    dispatchPiRpcJsonlChunk(state, 'not-json\n{"type":"ok"}\nalso { broken\n', listeners, {
      sessionId: "parse-error-test",
    });

    expect(events).toEqual([{ type: "ok" }]);
    expect(state.parseErrors).toBe(2);
  });

  it("keeps dispatching to later listeners when an earlier listener throws", () => {
    const events: Record<string, unknown>[] = [];
    const throwing = () => {
      throw new Error("listener boom");
    };
    const listeners = new Set<(event: Record<string, unknown>) => void>([
      throwing,
      (event) => events.push(event),
    ]);
    const state = { buffer: "" };

    dispatchPiRpcJsonlChunk(state, '{"type":"ok"}\n', listeners);

    expect(events).toEqual([{ type: "ok" }]);
  });
});

describe("buildPiRpcArgv", () => {
  const originalExtensions = process.env.PI_HARNESS_EXTENSIONS;

  afterEach(() => {
    if (originalExtensions === undefined) {
      delete process.env.PI_HARNESS_EXTENSIONS;
    } else {
      process.env.PI_HARNESS_EXTENSIONS = originalExtensions;
    }
  });

  it("rewrites pi-fork provider to the default downstream (claude-bridge) so pi can resolve the model", () => {
    expect(
      buildPiRpcArgv({
        prefixArgs: ["/pi/dist/cli.js"],
        config: { compactionTriggerTokens: 150_000 },
        provider: "pi-fork",
        modelId: "claude-sonnet-4-5",
        workspaceDir: "/workspace",
      }),
    ).toEqual([
      "/pi/dist/cli.js",
      "--provider",
      "claude-bridge",
      "--model",
      "claude-sonnet-4-5",
      "--compaction-trigger-tokens",
      "150000",
      "--mode",
      "rpc",
    ]);
  });

  it("honors config.downstreamProvider when rewriting pi-fork traffic", () => {
    expect(
      buildPiRpcArgv({
        prefixArgs: [],
        config: { downstreamProvider: "openai-codex" },
        provider: "pi-fork",
        modelId: "gpt-5.5",
      }),
    ).toEqual(["--provider", "openai-codex", "--model", "gpt-5.5", "--mode", "rpc"]);
  });

  it("passes non-pi-fork provider and model to the pi RPC process", () => {
    expect(
      buildPiRpcArgv({
        prefixArgs: [],
        config: {},
        provider: "openai",
        modelId: "gpt-5.1",
      }),
    ).toEqual(["--provider", "openai", "--model", "gpt-5.1", "--mode", "rpc"]);
  });

  it("replaces a session process when the requested workspace changes", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const workspaceA = mkdtempSync(join(tmpdir(), "my-pi-workspace-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "my-pi-workspace-b-"));
    const scriptPath = join(packageDir, "pi-rpc.mjs");
    writeFileSync(scriptPath, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    const config = {
      command: process.execPath,
      args: [scriptPath],
      myPiHarnessPackagePath: packageDir,
    };

    const first = await getOrCreatePiProcess("workspace-switch-test", {
      config,
      provider: "pi-fork",
      modelId: "claude-sonnet-4-5",
      workspaceDir: workspaceA,
    });
    const same = await getOrCreatePiProcess("workspace-switch-test", {
      config,
      provider: "pi-fork",
      modelId: "claude-sonnet-4-5",
      workspaceDir: workspaceA,
    });
    const changed = await getOrCreatePiProcess("workspace-switch-test", {
      config,
      provider: "pi-fork",
      modelId: "claude-sonnet-4-5",
      workspaceDir: workspaceB,
    });

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.requestedWorkspaceDir).toBe(workspaceB);
    clearPiProcess("workspace-switch-test");
  });

  it("replaces a session process when the requested model changes", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const scriptPath = join(packageDir, "pi-rpc.mjs");
    writeFileSync(scriptPath, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    const config = {
      command: process.execPath,
      args: [scriptPath],
      myPiHarnessPackagePath: packageDir,
    };

    const first = await getOrCreatePiProcess("model-switch-test", {
      config,
      provider: "pi-fork",
      modelId: "claude-opus-4-7",
    });
    const same = await getOrCreatePiProcess("model-switch-test", {
      config,
      provider: "pi-fork",
      modelId: "claude-opus-4-7",
    });
    const changed = await getOrCreatePiProcess("model-switch-test", {
      config,
      provider: "pi-fork",
      modelId: "claude-sonnet-4-5",
    });

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    clearPiProcess("model-switch-test");
  });

  it("notifies callers instead of crashing when the pi binary cannot spawn", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const processBinding = await getOrCreatePiProcess("missing-binary-test", {
      config: {
        command: "/definitely/missing/pi",
        myPiHarnessPackagePath: packageDir,
      },
    });

    await expect(
      new Promise<void>((resolve) => {
        processBinding.onClose.add(resolve);
      }),
    ).resolves.toBeUndefined();
    clearPiProcess("missing-binary-test");
  });

  it("side-loads per-deployment extension args from PI_HARNESS_EXTENSIONS", () => {
    process.env.PI_HARNESS_EXTENSIONS = "/opt/openclaw/ext-a.js,/opt/openclaw/ext-b.js";

    expect(
      buildPiRpcArgv({
        prefixArgs: [],
        config: {},
        provider: "pi-fork",
      }),
    ).toEqual(["-e", "/opt/openclaw/ext-a.js", "-e", "/opt/openclaw/ext-b.js", "--mode", "rpc"]);
  });
});
