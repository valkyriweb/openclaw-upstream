/**
 * AgentHarness implementation for the Pi Fork plugin.
 *
 * Selection policy:
 *   - Provider "pi-fork" → priority 100 (synthetic pi-mono-fork model refs)
 *   - Any other provider → unsupported; this harness must not steal built-in pi
 *     or native Codex traffic.
 *
 * Session lifecycle:
 *   - One long-lived pi RPC process per OpenClaw session (keepalive)
 *   - reset() kills the pi process and clears the binding
 *   - dispose() kills all pi processes on plugin shutdown
 */
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PiHarnessConfig } from "./config.js";
import { runPiRpcAttempt } from "./run-attempt.js";
import {
  clearAllPiProcesses,
  clearPiProcess,
  getOrCreatePiProcess,
  sendPiRpcCommand,
} from "./session-binding.js";

const DEFAULT_COMPACTION_TIMEOUT_MS = 60_000;

export function createPiAgentHarness(config: PiHarnessConfig = {}): AgentHarness {
  return {
    id: "pi-fork",
    label: "Pi coding-agent harness (pi-mono-fork)",

    supports(ctx) {
      const provider = ctx.provider.trim().toLowerCase();
      if (provider === "pi-fork") {
        return { supported: true, priority: 100 };
      }
      // Fail closed on non-pi-fork providers — harness is not a generic fallback.
      return {
        supported: false,
        reason: `pi-fork harness only supports the 'pi-fork' provider (got: ${ctx.provider})`,
      };
    },

    async runAttempt(params) {
      return runPiRpcAttempt(params, config);
    },

    async compact(params) {
      const sessionId = params.sessionId ?? params.sessionKey;
      if (!sessionId) {
        return { ok: false, compacted: false, reason: "missing session id for pi compaction" };
      }

      try {
        const piProcess = await getOrCreatePiProcess(sessionId, {
          config,
          modelId: params.model,
          provider: params.provider,
          workspaceDir: params.workspaceDir,
        });
        const response = await sendPiRpcCommand({
          piProcess,
          command: {
            type: "compact",
            ...(params.customInstructions ? { customInstructions: params.customInstructions } : {}),
          },
          timeoutMs: Math.min(config.turnTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS, 60_000),
        });
        const data = response.data as {
          summary?: unknown;
          firstKeptEntryId?: unknown;
          tokensBefore?: unknown;
          details?: unknown;
        };
        return {
          ok: true,
          compacted: true,
          result: {
            summary: typeof data?.summary === "string" ? data.summary : "",
            firstKeptEntryId:
              typeof data?.firstKeptEntryId === "string" ? data.firstKeptEntryId : "",
            tokensBefore: typeof data?.tokensBefore === "number" ? data.tokensBefore : 0,
            details: data?.details,
          },
        };
      } catch (error) {
        return {
          ok: false,
          compacted: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    reset(params) {
      const sessionId = params.sessionId ?? params.sessionKey;
      if (sessionId) {
        clearPiProcess(sessionId);
      }
    },

    dispose() {
      clearAllPiProcesses();
    },
  };
}
