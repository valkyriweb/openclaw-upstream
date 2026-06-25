import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countCanonicalTranscriptMessages, recordPiTurnCanonically } from "./canonical-recorder.js";

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

describe("pi-fork canonical recorder", () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-fork-canon-"));
    sessionFile = path.join(dir, "sessions", "019eXXXX.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the transcript header on a fresh session and appends the whole turn", async () => {
    const result = await recordPiTurnCanonically(
      { sessionFile, sessionId: "sess-1", cwd: "/work" },
      [userMsg("hi"), assistantMsg("hello")],
    );
    expect(result.appended).toBe(2);

    const entries = await readEntries(sessionFile);
    expect(entries[0]).toMatchObject({ type: "session" });
    expect(entries.filter((e) => e.type === "message")).toHaveLength(2);
    expect(entries[1].message?.role).toBe("user");
    expect(entries[2].message?.role).toBe("assistant");
  });

  it("appends only the delta on the next turn (count-cursor), no duplicates", async () => {
    const snapshot1 = [userMsg("q1"), assistantMsg("a1")];
    await recordPiTurnCanonically({ sessionFile, sessionId: "s" }, snapshot1);

    // Second turn: pi's snapshot is cumulative (full history + the new turn).
    const snapshot2 = [
      ...snapshot1,
      userMsg("q2"),
      assistantMsg("a2 calls tool"),
      toolResultMsg("tool output"),
      assistantMsg("a2 final"),
    ];
    const result = await recordPiTurnCanonically({ sessionFile, sessionId: "s" }, snapshot2);
    expect(result.appended).toBe(4);

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

  it("is idempotent when the same snapshot is recorded twice", async () => {
    const snapshot = [userMsg("q"), assistantMsg("a")];
    await recordPiTurnCanonically({ sessionFile, sessionId: "s" }, snapshot);
    const again = await recordPiTurnCanonically({ sessionFile, sessionId: "s" }, snapshot);
    expect(again.appended).toBe(0);
    expect((await readEntries(sessionFile)).filter((e) => e.type === "message")).toHaveLength(2);
  });

  it("counts zero messages for a missing transcript", async () => {
    expect(await countCanonicalTranscriptMessages(sessionFile)).toBe(0);
  });

  it("no-ops on empty input", async () => {
    expect((await recordPiTurnCanonically({ sessionFile }, [])).appended).toBe(0);
    expect(
      (await recordPiTurnCanonically({ sessionFile: undefined }, [userMsg("x")])).appended,
    ).toBe(0);
  });
});
