import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiTrajectoryRecorder } from "./trajectory-recorder.js";

type TrajectoryEvent = {
  type: string;
  traceId?: string;
  sessionId?: string;
  provider?: string;
  modelId?: string;
  data?: Record<string, unknown>;
};

async function readEvents(filePath: string): Promise<TrajectoryEvent[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TrajectoryEvent);
}

describe("pi-fork trajectory recorder", () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-fork-traj-"));
    sessionFile = path.join(dir, "sessions", "019eXXXX.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the full turn lifecycle keyed to the canonical session", async () => {
    const recorder = createPiTrajectoryRecorder({
      sessionId: "sess-1",
      sessionFile,
      workspaceDir: "/work",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      env: { OPENCLAW_TRAJECTORY: "1" },
    });
    expect(recorder).not.toBeNull();
    if (!recorder) {
      return;
    }

    recorder.recordSessionStarted({
      sessionFile,
      workspaceDir: "/work",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    recorder.recordPromptSubmitted({ prompt: "hello there" });
    recorder.recordModelCompleted({
      aborted: false,
      externalAbort: false,
      timedOut: false,
      assistantText: "hi back",
      messagesSnapshot: [{ role: "assistant", content: "hi back" }],
    });
    recorder.recordSessionEnded({ aborted: false, externalAbort: false, timedOut: false });
    await recorder.flush();

    const events = await readEvents(recorder.filePath);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "session.started",
      "prompt.submitted",
      "model.completed",
      "session.ended",
    ]);

    // Keyed to the canonical session, not pi's private session.
    for (const event of events) {
      expect(event.traceId).toBe("sess-1");
      expect(event.sessionId).toBe("sess-1");
    }

    const submitted = events.find((e) => e.type === "prompt.submitted");
    expect(submitted?.data?.prompt).toBe("hello there");

    const completed = events.find((e) => e.type === "model.completed");
    expect(completed?.data?.assistantTexts).toEqual(["hi back"]);

    const ended = events.find((e) => e.type === "session.ended");
    expect(ended?.data?.status).toBe("ok");
  });

  it("derives the terminal status from the failure flags", async () => {
    const recorder = createPiTrajectoryRecorder({
      sessionId: "sess-2",
      sessionFile,
      env: { OPENCLAW_TRAJECTORY: "1" },
    });
    if (!recorder) {
      throw new Error("recorder should be enabled");
    }
    recorder.recordSessionStarted({});
    recorder.recordSessionEnded({
      aborted: false,
      externalAbort: false,
      timedOut: true,
      promptError: undefined,
    });
    await recorder.flush();

    const ended = (await readEvents(recorder.filePath)).find((e) => e.type === "session.ended");
    expect(ended?.data?.status).toBe("timeout");
    expect(ended?.data?.timedOut).toBe(true);
  });

  it("emits session.ended exactly once (idempotent terminal)", async () => {
    const recorder = createPiTrajectoryRecorder({
      sessionId: "sess-3",
      sessionFile,
      env: { OPENCLAW_TRAJECTORY: "1" },
    });
    if (!recorder) {
      throw new Error("recorder should be enabled");
    }
    recorder.recordSessionEnded({ aborted: true, externalAbort: true, timedOut: false });
    recorder.recordSessionEnded({ aborted: false, externalAbort: false, timedOut: false });
    await recorder.flush();

    const ended = (await readEvents(recorder.filePath)).filter((e) => e.type === "session.ended");
    expect(ended).toHaveLength(1);
    // First terminal wins: aborted, not the later no-op call.
    expect(ended[0]?.data?.status).toBe("aborted");
  });

  it("returns null when trajectory capture is disabled", () => {
    const recorder = createPiTrajectoryRecorder({
      sessionId: "sess-4",
      sessionFile,
      env: { OPENCLAW_TRAJECTORY: "0" },
    });
    expect(recorder).toBeNull();
  });
});
