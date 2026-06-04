import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOrCreatePiProcess, sendPiRpcCommand, clearPiProcess, clearAllPiProcesses } = vi.hoisted(
  () => ({
    getOrCreatePiProcess: vi.fn(),
    sendPiRpcCommand: vi.fn(),
    clearPiProcess: vi.fn(),
    clearAllPiProcesses: vi.fn(),
  }),
);

vi.mock("./session-binding.js", () => ({
  getOrCreatePiProcess,
  sendPiRpcCommand,
  clearPiProcess,
  clearAllPiProcesses,
}));

import { createPiAgentHarness } from "./harness.js";

describe("createPiAgentHarness compact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps successful pi RPC compact responses", async () => {
    getOrCreatePiProcess.mockResolvedValue({ sessionId: "sess-1" });
    sendPiRpcCommand.mockResolvedValue({
      type: "response",
      command: "compact",
      success: true,
      data: {
        summary: "compacted summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 321,
        details: { readFiles: ["AGENTS.md"] },
      },
    });

    const harness = createPiAgentHarness({ turnTimeoutMs: 90_000 });
    const result = await harness.compact?.({
      sessionId: "sess-1",
      workspaceDir: ".",
      sessionFile: "session.jsonl",
      provider: "pi-fork",
      model: "claude-opus-4-7",
    });

    expect(getOrCreatePiProcess).toHaveBeenCalledWith("sess-1", {
      config: { turnTimeoutMs: 90_000 },
      modelId: "claude-opus-4-7",
      provider: "pi-fork",
      workspaceDir: ".",
    });
    expect(sendPiRpcCommand).toHaveBeenCalledWith({
      piProcess: { sessionId: "sess-1" },
      command: { type: "compact" },
      timeoutMs: 60_000,
    });
    expect(result).toEqual({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 321,
        details: { readFiles: ["AGENTS.md"] },
      },
    });
  });

  it("preserves pi assistant usage for OpenClaw context accounting", async () => {
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const send = vi.fn((command: Record<string, unknown>) => {
      if (command.type === "prompt") {
        queueMicrotask(() => {
          listeners.forEach((listener) => listener({ type: "agent_end", messages: [] }));
        });
        return;
      }
      if (command.type === "get_last_assistant_text") {
        queueMicrotask(() => {
          listeners.forEach((listener) =>
            listener({
              id: command.id,
              type: "response",
              command: "get_last_assistant_text",
              success: true,
              data: { text: "OK" },
            }),
          );
        });
        return;
      }
      if (command.type === "get_messages") {
        queueMicrotask(() => {
          listeners.forEach((listener) =>
            listener({
              id: command.id,
              type: "response",
              command: "get_messages",
              success: true,
              data: {
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "OK" }],
                    usage: { input: 37_000, output: 379, cacheRead: 2_400, total: 39_779 },
                  },
                ],
              },
            }),
          );
        });
      }
    });
    getOrCreatePiProcess.mockResolvedValue({
      listeners,
      onClose: new Set(),
      send,
    });

    const harness = createPiAgentHarness();
    const result = await harness.runAttempt({
      prompt: "status context test",
      provider: "pi-fork",
      modelId: "gpt-5.5",
    } as never);

    expect(result.lastAssistant?.usage).toEqual({
      input: 37_000,
      output: 379,
      cacheRead: 2_400,
      cacheWrite: undefined,
      total: 39_779,
    });
    expect(result.attemptUsage).toEqual(result.lastAssistant?.usage);
  });

  it("includes custom instructions when provided", async () => {
    getOrCreatePiProcess.mockResolvedValue({ sessionId: "sess-1" });
    sendPiRpcCommand.mockResolvedValue({
      type: "response",
      command: "compact",
      success: true,
      data: {},
    });

    const harness = createPiAgentHarness();
    await harness.compact?.({
      sessionId: "sess-1",
      workspaceDir: ".",
      sessionFile: "session.jsonl",
      customInstructions: "Keep deployment notes.",
    });

    expect(sendPiRpcCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "compact", customInstructions: "Keep deployment notes." },
      }),
    );
  });

  it("returns a structured failure when compaction rpc fails", async () => {
    getOrCreatePiProcess.mockResolvedValue({ sessionId: "sess-1" });
    sendPiRpcCommand.mockRejectedValue(new Error("Pi RPC compact timed out after 60000ms"));

    const harness = createPiAgentHarness();
    const result = await harness.compact?.({
      sessionId: "sess-1",
      workspaceDir: ".",
      sessionFile: "session.jsonl",
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "Pi RPC compact timed out after 60000ms",
    });
  });
});
