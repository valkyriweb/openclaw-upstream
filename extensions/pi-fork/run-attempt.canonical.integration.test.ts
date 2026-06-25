/**
 * Integration test: pi-fork turn -> canonical OpenClaw transcript.
 *
 * Drives the REAL `runPiRpcAttempt` event loop (prompt -> stream -> agent_end ->
 * get_last_assistant_text + get_messages -> resolveResult) against a scripted
 * fake pi RPC process. Only the pi *process* (session-binding) is mocked; the
 * recorder, the finish()/queryFinalText path, and the canonical write all run
 * for real. This closes the gap the unit test cannot: that run-attempt actually
 * invokes recordPiTurnCanonically with params.sessionFile + pi's get_messages
 * snapshot, producing a canonical transcript readable by the sessions pipeline.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Json = Record<string, unknown>;

/** Scripted fake pi process; swapped per-test via the hoisted factory slot. */
const piSlot = vi.hoisted(() => ({
  factory: null as null | (() => unknown),
}));

vi.mock("./session-binding.js", () => ({
  getOrCreatePiProcess: vi.fn(async () => {
    if (!piSlot.factory) {
      throw new Error("test did not set a pi process factory");
    }
    return piSlot.factory();
  }),
  clearPiProcess: vi.fn(),
  formatPiStderrTail: vi.fn(() => ""),
  sendPiRpcCommand: vi.fn(async () => ({ type: "response", command: "steer", success: true })),
}));

import { countCanonicalTranscriptMessages } from "./canonical-recorder.js";
// Imported after the mock is registered so run-attempt binds the fake binding.
import { runPiRpcAttempt } from "./run-attempt.js";

type Entry = { type: string; message?: { role?: string; content?: unknown } };

async function readEntries(sessionFile: string): Promise<Entry[]> {
  const text = await readFile(sessionFile, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Entry);
}

function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantMsg(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function toolResultMsg(text: string) {
  return { role: "toolResult", content: [{ type: "text", text }] };
}

/**
 * Build a fake PiRpcProcess that, on prompt, acks then streams one assistant
 * message and ends the turn, and answers get_last_assistant_text / get_messages
 * from the provided cumulative snapshot. Events are dispatched on a microtask to
 * mimic pi's async stdout, exercising run-attempt's real listener plumbing.
 */
function makeFakePi(snapshot: unknown[], finalText: string) {
  const listeners = new Set<(e: Json) => void>();
  const onClose = new Set<() => void>();
  const dispatch = (e: Json) => {
    for (const l of [...listeners]) {
      l(e);
    }
  };
  return {
    proc: { exitCode: null, killed: false, signalCode: null },
    sessionId: "fake-pi",
    listeners,
    onClose,
    turnActive: false,
    stderrTail: [] as string[],
    send: (obj: Json) => {
      const type = obj?.type as string | undefined;
      if (type === "prompt") {
        queueMicrotask(() => {
          dispatch({ type: "response", command: "prompt", success: true, id: obj.id });
          dispatch({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: finalText }] },
          });
          dispatch({ type: "agent_end", messages: snapshot });
        });
        return;
      }
      if (type === "get_last_assistant_text") {
        queueMicrotask(() =>
          dispatch({
            type: "response",
            id: obj.id,
            command: "get_last_assistant_text",
            success: true,
            data: { text: finalText },
          }),
        );
        return;
      }
      if (type === "get_messages") {
        queueMicrotask(() =>
          dispatch({
            type: "response",
            id: obj.id,
            command: "get_messages",
            success: true,
            data: { messages: snapshot },
          }),
        );
        return;
      }
    },
  };
}

function makeParams(sessionFile: string, prompt: string) {
  return {
    sessionId: "sess-int-1",
    sessionFile,
    workspaceDir: "/work",
    provider: "claude-bridge",
    modelId: "claude-sonnet-4-6",
    prompt,
    config: {},
  } as unknown as Parameters<typeof runPiRpcAttempt>[0];
}

describe("pi-fork run-attempt -> canonical transcript (integration)", () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-fork-int-"));
    sessionFile = path.join(dir, "sessions", "019eINTEG.jsonl");
  });
  afterEach(async () => {
    piSlot.factory = null;
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("mirrors a pi turn into the canonical transcript at params.sessionFile", async () => {
    const snapshot = [userMsg("ping"), assistantMsg("pong")];
    piSlot.factory = () => makeFakePi(snapshot, "pong");

    const result = await runPiRpcAttempt(makeParams(sessionFile, "ping"), { turnTimeoutMs: 4_000 });

    // resolveResult ran with pi's authoritative text.
    expect((result as { assistantTexts?: string[] }).assistantTexts).toEqual(["pong"]);

    // Canonical transcript exists with a real session header + both messages.
    const entries = await readEntries(sessionFile);
    expect(entries[0]).toMatchObject({ type: "session" });
    const messages = entries.filter((e) => e.type === "message");
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.message?.role)).toEqual(["user", "assistant"]);
    expect(await countCanonicalTranscriptMessages(sessionFile)).toBe(2);
  });

  it("appends only the delta on a second serialized turn (cursor across run-attempt)", async () => {
    const turn1 = [userMsg("q1"), assistantMsg("a1")];
    piSlot.factory = () => makeFakePi(turn1, "a1");
    await runPiRpcAttempt(makeParams(sessionFile, "q1"), { turnTimeoutMs: 4_000 });

    // pi's snapshot is cumulative: full history + the new turn (with a tool).
    const turn2 = [
      ...turn1,
      userMsg("q2"),
      assistantMsg("a2 calls tool"),
      toolResultMsg("tool output"),
      assistantMsg("a2 final"),
    ];
    piSlot.factory = () => makeFakePi(turn2, "a2 final");
    const result = await runPiRpcAttempt(makeParams(sessionFile, "q2"), { turnTimeoutMs: 4_000 });

    expect((result as { assistantTexts?: string[] }).assistantTexts).toEqual(["a2 final"]);
    const messages = (await readEntries(sessionFile)).filter((e) => e.type === "message");
    expect(messages).toHaveLength(6);
    expect(messages.map((m) => m.message?.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });
});
