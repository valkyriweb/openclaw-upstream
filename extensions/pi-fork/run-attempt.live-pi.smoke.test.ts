/**
 * Live real-pi smoke: spawn a REAL pi RPC process via session-binding, run one
 * turn through the REAL runPiRpcAttempt, and assert the canonical OpenClaw
 * transcript is written + readable. This is the only check that validates pi's
 * actual `get_messages` RPC payload shape against the recorder (the mocked
 * integration test scripts that payload); the deterministic test covers wiring,
 * this covers the live contract.
 *
 * Gated behind PIFORK_LIVE_SMOKE=1 so CI stays hermetic (it makes a real
 * claude-bridge model call). Fully isolated: piAgentDir is a temp dir, so it
 * never touches ~/.openclaw/pi-fork-agent (the live gateway's pi state).
 *
 * Run:
 *   PIFORK_LIVE_SMOKE=1 npx vitest run \
 *     extensions/pi-fork/run-attempt.live-pi.smoke.test.ts --testTimeout=120000
 *
 * Prereqs: claude-bridge up on :9100, ~/.local/bin/pi present,
 * ~/Projects/personal/my-pi/packages/my-pi-harness present, ~/.pi/agent/models.json
 * with a claude-bridge provider.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { countCanonicalTranscriptMessages } from "./canonical-recorder.js";
import { runPiRpcAttempt } from "./run-attempt.js";
import { clearAllPiProcesses } from "./session-binding.js";

type Entry = { type: string; message?: { role?: string; content?: unknown } };

const LIVE = process.env.PIFORK_LIVE_SMOKE === "1";

describe.skipIf(!LIVE)("pi-fork live real-pi -> canonical transcript (smoke)", () => {
  afterAll(() => {
    clearAllPiProcesses();
  });

  it("spawns a real pi, runs a turn, and writes a readable canonical transcript", async () => {
    // The openclaw vitest setup overrides $HOME to a temp dir, so resolve the
    // real home from the passwd db to find the installed pi + my-pi-harness.
    const realHome = userInfo().homedir;
    const dir = await mkdtemp(path.join(tmpdir(), "pi-fork-live-"));
    const agentDir = path.join(dir, "agent");
    const workspaceDir = path.join(dir, "workspace");
    const sessionFile = path.join(dir, "sessions", "019eLIVE.jsonl");
    await mkdir(workspaceDir, { recursive: true });

    // The pi launcher script resolves its binary from $HOME at runtime, and pi's
    // managed-runtime reads $HOME for the binary + my-pi-harness + models catalog.
    // Point $HOME at the real home for the spawn; all writes still target the
    // temp piAgentDir, so live ~/.openclaw / ~/.pi state is untouched.
    const origHome = process.env.HOME;
    process.env.HOME = realHome;

    try {
      const config = {
        command: `${realHome}/.local/bin/pi`,
        downstreamProvider: "claude-bridge",
        myPiHarnessPackagePath: `${realHome}/Projects/personal/my-pi/packages/my-pi-harness`,
        piAgentDir: agentDir,
        piAuthPath: path.join(agentDir, "auth.json"),
        turnTimeoutMs: 110_000,
      } as unknown as Parameters<typeof runPiRpcAttempt>[1];

      const params = {
        sessionId: "live-smoke-1",
        sessionFile,
        workspaceDir,
        provider: "pi-fork",
        modelId: "claude-opus-4-8",
        prompt: "Reply with exactly: OK and nothing else.",
        config: {},
      } as unknown as Parameters<typeof runPiRpcAttempt>[0];

      const result = await runPiRpcAttempt(params, config);

      // The turn produced an assistant reply (not an error/abort).
      const r = result as { promptError?: unknown; assistantTexts?: string[] };
      expect(r.promptError ?? null).toBeNull();
      expect((r.assistantTexts ?? []).join("")).not.toBe("");

      // Canonical transcript: real header + at least the user + assistant turn,
      // written straight from pi's live get_messages snapshot.
      const text = await readFile(sessionFile, "utf8");
      const entries = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Entry);

      expect(entries[0]).toMatchObject({ type: "session" });
      const messages = entries.filter((e) => e.type === "message");
      const roles = messages.map((m) => m.message?.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(await countCanonicalTranscriptMessages(sessionFile)).toBe(messages.length);
      // eslint-disable-next-line no-console
      console.log(`[live-smoke] canonical messages=${messages.length} roles=${roles.join(",")}`);
    } finally {
      process.env.HOME = origHome;
      clearAllPiProcesses();
      if (!process.env.PIFORK_LIVE_KEEP) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
