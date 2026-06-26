import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueAgentHarnessMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildAttemptResult,
  buildPiPromptCommand,
  resolvePiTurnTimeoutMs,
  runPiRpcAttempt,
} from "./run-attempt.js";
import { clearPiProcess, getOrCreatePiProcess } from "./session-binding.js";

// These turns set no sessionFile, so the default-on runtime trajectory recorder
// would spill <sessionId>.trajectory.jsonl into the repo cwd. None of these
// tests assert trajectory (see trajectory-recorder.test.ts +
// run-attempt.canonical.integration.test.ts for that), so disable capture here.
let prevTrajectoryEnv: string | undefined;
beforeAll(() => {
  prevTrajectoryEnv = process.env.OPENCLAW_TRAJECTORY;
  process.env.OPENCLAW_TRAJECTORY = "0";
});
afterAll(() => {
  if (prevTrajectoryEnv === undefined) {
    delete process.env.OPENCLAW_TRAJECTORY;
  } else {
    process.env.OPENCLAW_TRAJECTORY = prevTrajectoryEnv;
  }
});

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("pollUntil timed out");
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
}

describe("buildPiPromptCommand", () => {
  it("forwards current-turn image attachments to Pi RPC prompt", () => {
    const images = [{ type: "image", data: "base64-png", mimeType: "image/png" }];

    expect(
      buildPiPromptCommand(
        {
          prompt: "what is in this image?",
          images,
        } as never,
        {},
      ),
    ).toEqual({
      type: "prompt",
      message: "what is in this image?",
      images,
    });
  });

  it("omits empty image attachment arrays from Pi RPC prompt", () => {
    expect(
      buildPiPromptCommand(
        {
          prompt: "text only",
          images: [],
        } as never,
        {},
      ),
    ).toEqual({ type: "prompt", message: "text only" });
  });
});

describe("resolvePiTurnTimeoutMs", () => {
  it("prefers per-run timeout overrides over plugin defaults", () => {
    expect(
      resolvePiTurnTimeoutMs({ runTimeoutOverrideMs: 45_000, timeoutMs: 60_000 } as never, {
        turnTimeoutMs: 300_000,
      }),
    ).toBe(45_000);
    expect(resolvePiTurnTimeoutMs({ timeoutMs: 60_000 } as never, { turnTimeoutMs: 300_000 })).toBe(
      60_000,
    );
  });
});

describe("runPiRpcAttempt", () => {
  it("does not wait for the fallback timer when optional final-state RPCs fail", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const scriptPath = join(packageDir, "pi-rpc.mjs");
    writeFileSync(
      scriptPath,
      `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "fallback text" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: "fallback text" }] }) + "\\n");
      continue;
    }
    if (command.type === "get_last_assistant_text" || command.type === "get_messages") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported" }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    );
    const sessionId = "final-state-failure-test";
    const startedAt = Date.now();

    try {
      const result = (await runPiRpcAttempt({ sessionId, prompt: "hello" } as never, {
        command: process.execPath,
        args: [scriptPath],
        myPiHarnessPackagePath: packageDir,
      })) as { lastAssistant: { content: Array<{ text: string }> } };

      expect(result.lastAssistant.content[0]?.text).toBe("fallback text");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      clearPiProcess(sessionId);
    }
  });

  it("removes per-turn close handlers after a successful turn", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const scriptPath = join(packageDir, "pi-rpc.mjs");
    writeFileSync(
      scriptPath,
      `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "done" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\\n");
      continue;
    }
    if (command.type === "get_last_assistant_text") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { text: "done" } }) + "\\n");
    }
    if (command.type === "get_messages") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { messages: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    );
    const sessionId = "close-handler-cleanup-test";
    const config = {
      command: process.execPath,
      args: [scriptPath],
      myPiHarnessPackagePath: packageDir,
    };

    try {
      await runPiRpcAttempt({ sessionId, prompt: "hello" } as never, config);
      const processBinding = await getOrCreatePiProcess(sessionId, { config });

      expect(processBinding.onClose.size).toBe(0);
      expect(processBinding.listeners.size).toBe(0);
    } finally {
      clearPiProcess(sessionId);
    }
  });
});

describe("runPiRpcAttempt steering parity", () => {
  it("steers a burst message into the active pi turn via the registered queue handle", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const scriptPath = join(packageDir, "pi-rpc-steer.mjs");
    writeFileSync(
      scriptPath,
      `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      // Keep the turn open; only a steer completes it.
      process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "working" } }) + "\\n");
      continue;
    }
    if (command.type === "steer") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "steer", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "steered:" + command.message } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\\n");
      continue;
    }
    if (command.type === "get_last_assistant_text") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { text: "steered-final" } }) + "\\n");
    }
    if (command.type === "get_messages") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { messages: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    );
    const sessionId = "steer-parity-test";
    const config = {
      command: process.execPath,
      args: [scriptPath],
      myPiHarnessPackagePath: packageDir,
    };

    try {
      const attempt = runPiRpcAttempt({ sessionId, prompt: "first message" } as never, config);
      // The queue handle registers once the attempt is in flight; until then the
      // queue reports no active run. This mirrors OpenClaw's steer-mode path for
      // a burst of forwarded messages.
      await pollUntil(
        () => queueAgentHarnessMessage(sessionId, "second forwarded message"),
        (queued) => queued === true,
      );

      const result = (await attempt) as {
        lastAssistant: { content: Array<{ text: string }> };
        promptError: unknown;
      };
      expect(result.promptError).toBeNull();
      expect(result.lastAssistant.content[0]?.text).toBe("steered-final");
      // After the turn resolves the handle must be deregistered.
      expect(queueAgentHarnessMessage(sessionId, "late message")).toBe(false);
    } finally {
      clearPiProcess(sessionId);
    }
  });

  it("reports run progress for prompt, tool, and stream events", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const scriptPath = join(packageDir, "pi-rpc-progress.mjs");
    writeFileSync(
      scriptPath,
      `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "test_tool", args: {} }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "test_tool", result: {}, isError: false }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "done" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\\n");
      continue;
    }
    if (command.type === "get_last_assistant_text") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { text: "done" } }) + "\\n");
    }
    if (command.type === "get_messages") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { messages: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    );
    const sessionId = "progress-parity-test";
    const onRunProgress = vi.fn();

    try {
      await runPiRpcAttempt({ sessionId, prompt: "hello", onRunProgress } as never, {
        command: process.execPath,
        args: [scriptPath],
        myPiHarnessPackagePath: packageDir,
      });

      const reasons = onRunProgress.mock.calls.map(
        (call) => (call[0] as { reason: string }).reason,
      );
      expect(reasons).toContain("prompt_sent");
      expect(reasons).toContain("tool_start:test_tool");
      expect(reasons).toContain("tool_end:test_tool");
      for (const call of onRunProgress.mock.calls) {
        expect((call[0] as { backend?: string }).backend).toBe("pi-fork-rpc");
      }
    } finally {
      clearPiProcess(sessionId);
    }
  });
});

describe("runPiRpcAttempt zombie-turn recovery", () => {
  it("heals a busy pi binding by respawning and resending the prompt once", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const scriptPath = join(packageDir, "pi-rpc-busy.mjs");
    const markerPath = join(packageDir, "busy-marker");
    writeFileSync(
      scriptPath,
      `
import { existsSync, writeFileSync } from "node:fs";
const MARKER = ${JSON.stringify(markerPath)};
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      if (!existsSync(MARKER)) {
        writeFileSync(MARKER, "1");
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: false, error: "Agent is already processing. Specify streamingBehavior to queue the message." }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "healed" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\\n");
      continue;
    }
    if (command.type === "get_last_assistant_text") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { text: "healed" } }) + "\\n");
    }
    if (command.type === "get_messages") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { messages: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    );
    const sessionId = "busy-heal-test";

    try {
      const result = (await runPiRpcAttempt({ sessionId, prompt: "hello" } as never, {
        command: process.execPath,
        args: [scriptPath],
        myPiHarnessPackagePath: packageDir,
      })) as { lastAssistant: { content: Array<{ text: string }> }; promptError: unknown };

      expect(result.promptError).toBeNull();
      expect(result.lastAssistant.content[0]?.text).toBe("healed");
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      clearPiProcess(sessionId);
    }
  });

  it("returns immediately on external abort and respawns past the zombie turn on the next attempt", async () => {
    const packageDir = mkdtempSync(join(tmpdir(), "my-pi-harness-"));
    const scriptPath = join(packageDir, "pi-rpc-zombie.mjs");
    const abortLogPath = join(packageDir, "abort-log");
    const markerPath = join(packageDir, "zombie-marker");
    writeFileSync(
      scriptPath,
      `
import { existsSync, writeFileSync } from "node:fs";
const MARKER = ${JSON.stringify(markerPath)};
const ABORT_LOG = ${JSON.stringify(abortLogPath)};
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      if (!existsSync(MARKER)) {
        // First process: stream forever and ignore aborts (zombie turn).
        writeFileSync(MARKER, "1");
        process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "working" } }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "recovered" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\\n");
      continue;
    }
    if (command.type === "abort") {
      writeFileSync(ABORT_LOG, "aborted");
      continue;
    }
    if (command.type === "get_last_assistant_text") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { text: "recovered" } }) + "\\n");
    }
    if (command.type === "get_messages") {
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { messages: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    );
    const sessionId = "abort-zombie-test";
    const config = {
      command: process.execPath,
      args: [scriptPath],
      myPiHarnessPackagePath: packageDir,
    };

    try {
      const abortController = new AbortController();
      const attempt = runPiRpcAttempt(
        { sessionId, prompt: "hello", abortSignal: abortController.signal } as never,
        config,
      );
      const firstBinding = await pollUntil(
        () => getOrCreatePiProcess(sessionId, { config }),
        (binding) => binding.turnActive,
      );
      const firstPid = firstBinding.proc.pid;
      abortController.abort();

      const result = (await attempt) as { aborted: boolean; externalAbort: boolean };
      expect(result.aborted).toBe(true);
      expect(result.externalAbort).toBe(true);
      // The abort command reached pi even though pi refused to stop.
      await pollUntil(
        () => existsSync(abortLogPath),
        (logged) => logged,
      );
      expect(readFileSync(abortLogPath, "utf8")).toBe("aborted");

      // Next attempt detects the still-turn-active zombie binding, respawns,
      // and completes normally instead of inheriting the wedged stream.
      const second = (await runPiRpcAttempt({ sessionId, prompt: "again" } as never, config)) as {
        lastAssistant: { content: Array<{ text: string }> };
        promptError: unknown;
      };
      expect(second.promptError).toBeNull();
      expect(second.lastAssistant.content[0]?.text).toBe("recovered");
      const secondBinding = await getOrCreatePiProcess(sessionId, { config });
      expect(secondBinding.proc.pid).not.toBe(firstPid);
    } finally {
      clearPiProcess(sessionId);
    }
  });
});

describe("buildAttemptResult", () => {
  it("marks timed-out turns with active tool calls as side-effectful and not replay-safe", () => {
    const result = buildAttemptResult({
      assistantText: "",
      toolMetas: [],
      activeToolCount: 1,
      messagesSnapshot: [],
      sessionIdUsed: "session-1",
      aborted: false,
      externalAbort: false,
      timedOut: true,
      promptError: null,
    }) as {
      replayMetadata: { hadPotentialSideEffects: boolean; replaySafe: boolean };
      itemLifecycle: { startedCount: number; completedCount: number; activeCount: number };
    };

    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(result.itemLifecycle).toEqual({
      startedCount: 1,
      completedCount: 0,
      activeCount: 1,
    });
  });
});
