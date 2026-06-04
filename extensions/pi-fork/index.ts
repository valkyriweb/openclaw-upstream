/**
 * Pi Fork — OpenClaw plugin entry point.
 *
 * Registers a "pi" agent harness and a synthetic "pi" model provider so
 * OpenClaw can route agent turns through pi-mono-fork's RPC runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * How it works
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On each OpenClaw session a persistent pi process is spawned in `--mode rpc`.
 * Turns are forwarded via JSONL (stdin → stdout). Pi owns tool execution,
 * session history, and compaction. OpenClaw owns channel delivery, transcript
 * mirroring, and session selection.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Quick config example (openclaw.json)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   {
 *     "plugins": {
 *       "allow": ["pi-fork"],
 *       "config": {
 *         "pi-fork": {
 *           "command": "/Users/you/.local/bin/pi",
 *           "compactionTriggerTokens": 150000
 *         }
 *       }
 *     },
 *     "agents": {
 *       "defaults": {
 *         "model": "pi/claude-opus-4-7",
 *         "models": {
 *           "pi-fork/claude-opus-4-7": {
 *             "agentRuntime": { "id": "pi-fork" }
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Supported pi binary resolution order (no config.command needed if on PATH):
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. config.command (if set)
 *   2. ~/Projects/personal/pi-mono-fork/packages/coding-agent/dist/cli.js
 *   3. ~/.local/bin/pi
 *   4. "pi" on PATH
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PiHarnessConfig } from "./config.js";
import { createPiAgentHarness } from "./harness.js";
import { buildPiProvider } from "./provider.js";

export default definePluginEntry({
  id: "pi-fork",
  name: "Pi Fork",
  description:
    "Routes OpenClaw agent turns through the Pi coding-agent RPC runtime (pi-mono-fork). " +
    "Pi owns tool execution, session history, and compaction.",
  register(api) {
    const config = (api.pluginConfig ?? {}) as PiHarnessConfig;
    api.registerAgentHarness(createPiAgentHarness(config));
    api.registerProvider(buildPiProvider());
  },
});
