/**
 * Pi Fork plugin config helpers.
 */
import { existsSync } from "node:fs";
import { ensureManagedPiRuntime } from "./managed-runtime.js";

/** Shape of the user-facing plugin config block under `plugins.config.pi-fork`. */
export interface PiHarnessConfig {
  /** Path to the pi binary. Falls back to 'pi' on PATH or the pi-mono-fork local dist. */
  command?: string;
  /** Extra argv prepended before --mode rpc. */
  args?: string[];
  /**
   * Concrete pi-side provider to route synthetic `pi-fork/<model>` requests through.
   * Pi resolves model ids against its own models.json catalog; `pi-fork` is only an
   * OpenClaw-namespace marker and does not exist as a provider inside pi. Default:
   * `"claude-bridge"`, which matches the claude-bridge sidecar that ships in the
   * openclaw-custom image. Set to another id (e.g. `"openai-codex"`) to route
   * pi-fork traffic through a different pi-side provider.
   */
  downstreamProvider?: string;
  /** Maximum ms to wait for a turn. Default: 300000 (5 min). */
  turnTimeoutMs?: number;
  /** Prompt payload strategy. Defaults to full OpenClaw prompt passthrough. */
  promptContextMode?: "full" | "lean-automation";
  /** Automation triggers eligible for lean prompts when promptContextMode is lean-automation. */
  leanPromptTriggers?: Array<"heartbeat" | "cron">;
  /** Absolute context-token count where the spawned pi runtime should auto-compact. */
  compactionTriggerTokens?: number;
  /** Path or git URL for a pi-mono-fork checkout the plugin should install/build. */
  piMonoForkSource?: string;
  /** Optional git ref when piMonoForkSource is a git URL. */
  piMonoForkRef?: string;
  /** Managed runtime directory. Defaults to $OPENCLAW_HOME/pi-mono-fork. */
  piMonoForkRuntimeDir?: string;
  /** Install/build the managed runtime when missing. Defaults to true. */
  piMonoForkAutoInstall?: boolean;
  /** my-pi-harness package path loaded through the spawned Pi settings.json. */
  myPiHarnessPackagePath?: string;
  /** OpenClaw auth-profiles.json source used to sync openai-codex OAuth into pi auth. */
  authProfilesPath?: string;
  /** Pi auth.json path. Defaults to ~/.pi/agent/auth.json. */
  piAuthPath?: string;
  /** Pi agent config directory. Defaults to the parent directory of piAuthPath. */
  piAgentDir?: string;
  /**
   * Native pi tool aliases to drop in the spawned pi (written to settings.json
   * as `extensions.native-tool-overrides.exclude`, read by the my-pi
   * native-tool-overrides extension). Default: ["Agent"] — pi sub-agents cost
   * ~140k tokens/session and are not used by OpenClaw-driven turns.
   */
  nativeToolExclude?: string[];
  /**
   * Static catalog of OpenClaw tools to surface inside the spawned pi as
   * provider-native deferred proxy tools (progressive disclosure via
   * tool-search). Serialized verbatim into settings.json under
   * `extensions.openclaw-adaptor.tools` and registered by the my-pi
   * openclaw-adaptor extension. Each entry names a backing MCP server + remote
   * tool; execution shells out to `adaptorExec` (mcporter by default).
   */
  adaptorTools?: Array<{
    name: string;
    server: string;
    tool: string;
    description?: string;
    label?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  /** Execution command for adaptor tools. Placeholders: {server} {tool} {args}. */
  adaptorExec?: { command?: string; args?: string[] };
  /** Per-call timeout (ms) for adaptor tool execution. */
  adaptorTimeoutMs?: number;
}

/** Well-known fallback locations for the pi binary, in preference order. */
const FALLBACK_PI_PATHS = [
  // pi-mono-fork local build (relative to standard home dir layout)
  `${process.env.HOME}/Projects/personal/pi-mono-fork/packages/coding-agent/dist/cli.js`,
  // pi CLI installed to user's local bin
  `${process.env.HOME}/.local/bin/pi`,
];

/**
 * Resolve the pi binary to use for spawning the RPC process.
 * Order: config.command → PATH 'pi' → fallback local dist paths.
 */
export function resolvePiBinary(config: PiHarnessConfig): string {
  if (config.command) {
    return config.command;
  }

  // Check if 'pi' is on PATH (skip full which() for simplicity — spawn will fail fast if not)
  // Check fallback paths next
  for (const fallback of FALLBACK_PI_PATHS) {
    if (existsSync(fallback)) {
      // If it's a .js file, run it with node
      if (fallback.endsWith(".js")) {
        return process.execPath; // will be combined with args in the caller
      }
      return fallback;
    }
  }

  // Default: assume 'pi' is on PATH
  return "pi";
}

/**
 * Resolve binary + args tuple, handling the case where the resolved binary is a
 * Node.js script (dist/cli.js) that needs to be invoked as `node <script> ...`.
 */
export function resolvePiCommand(config: PiHarnessConfig): { bin: string; prefixArgs: string[] } {
  if (config.command) {
    ensureManagedPiRuntime(config);
    return { bin: config.command, prefixArgs: [] };
  }

  const managed = ensureManagedPiRuntime(config);
  if (managed) {
    return { bin: managed, prefixArgs: [] };
  }

  for (const fallback of FALLBACK_PI_PATHS) {
    if (existsSync(fallback)) {
      if (fallback.endsWith(".js")) {
        return { bin: process.execPath, prefixArgs: [fallback] };
      }
      return { bin: fallback, prefixArgs: [] };
    }
  }

  return { bin: "pi", prefixArgs: [] };
}
