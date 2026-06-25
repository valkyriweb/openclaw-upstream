/**
 * Canonical session recording for the Pi Fork runtime.
 *
 * pi-fork runs Kael's turns through a spawned upstream-pi RPC process, which
 * persists its own private transcript under PI_CODING_AGENT_DIR. That tree is
 * invisible to OpenClaw's canonical session pipeline (memory_search,
 * sessions_list/history, trajectory, export, archive/prune) because — unlike
 * the embedded/codex runtimes, which self-record inside the embedded runner —
 * the pi-fork harness never drove core's recording primitives.
 *
 * This module mirrors each pi turn into the canonical transcript at
 * `params.sessionFile` using the same core primitive the embedded runner uses
 * (`appendSessionTranscriptMessage`, which auto-creates the `<id>.jsonl`
 * header). It is OpenClaw-side only and consumes pi's stock upstream
 * `get_messages` RPC snapshot — no pi-mono-fork changes, and no dependence on
 * fork-specific pi behaviour.
 *
 * Invariant: the canonical transcript mirrors pi's message list 1:1. Each turn
 * we append only the messages beyond what is already persisted (a count-delta
 * cursor). Core does NOT record the user turn for pi-fork — the user-turn
 * recorder is consumed only inside the embedded runner, which pi-fork bypasses —
 * so pi-fork records the entire turn: user, assistant, and toolResult messages.
 *
 * Concurrency: turns on a session are serialized by OpenClaw's session lane, and
 * the caller awaits this function before resolving the attempt. That ordering is
 * what keeps the count cursor correct; a fire-and-forget call would let the next
 * turn read a stale count and double-append.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { appendSessionTranscriptMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export type PiCanonicalRecorderTarget = {
  /** Canonical transcript path resolved by core (params.sessionFile). */
  sessionFile?: string;
  /** Canonical session id, written into the transcript header on a fresh file. */
  sessionId?: string;
  /** Workspace dir, written as the session header cwd on a fresh file. */
  cwd?: string;
  /** OpenClaw config, for transcript redaction + write-lock options. */
  config?: OpenClawConfig;
};

/**
 * Count persisted `type:"message"` entries in a canonical transcript. Non-message
 * entries (the `session` header, `model_change`, `thinking_level_change`) are
 * excluded so the count aligns 1:1 with pi's `session.messages` snapshot. A
 * missing file means a fresh session => 0 already-recorded messages.
 */
export async function countCanonicalTranscriptMessages(sessionFile: string): Promise<number> {
  let count = 0;
  try {
    const rl = createInterface({
      input: createReadStream(sessionFile, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      // Cheap prefilter before JSON.parse on hot transcripts.
      if (!trimmed || !trimmed.includes('"message"')) {
        continue;
      }
      try {
        if ((JSON.parse(trimmed) as { type?: unknown }).type === "message") {
          count += 1;
        }
      } catch {
        // Tolerate a partial/corrupt trailing line.
      }
    }
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "ENOENT") {
      return 0;
    }
    throw err;
  }
  return count;
}

/**
 * Mirror a completed pi turn into the canonical transcript.
 *
 * @param target    Canonical destination + header metadata.
 * @param messages  pi's authoritative `get_messages` snapshot (AgentMessage[]).
 * @returns number of newly-appended canonical entries.
 */
export async function recordPiTurnCanonically(
  target: PiCanonicalRecorderTarget,
  messages: unknown[],
): Promise<{ appended: number }> {
  const sessionFile = target.sessionFile;
  if (!sessionFile || !Array.isArray(messages) || messages.length === 0) {
    return { appended: 0 };
  }

  const alreadyRecorded = await countCanonicalTranscriptMessages(sessionFile);
  if (alreadyRecorded >= messages.length) {
    return { appended: 0 };
  }

  let appended = 0;
  // Append every new message unconditionally: skipping one would desync the
  // count cursor (the next turn would re-slice from the gap and double-append
  // everything after it). pi messages always carry a role; appendSession-
  // TranscriptMessage tolerates any shape via its redaction fallback.
  for (let i = alreadyRecorded; i < messages.length; i += 1) {
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: messages[i],
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.cwd ? { cwd: target.cwd } : {}),
      ...(target.config ? { config: target.config } : {}),
    });
    appended += 1;
  }
  return { appended };
}
