import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAttemptResult,
  buildPiPromptCommand,
  resolvePiTurnTimeoutMs,
  runPiRpcAttempt,
} from "./run-attempt.js";
import { clearPiProcess, getOrCreatePiProcess } from "./session-binding.js";

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
