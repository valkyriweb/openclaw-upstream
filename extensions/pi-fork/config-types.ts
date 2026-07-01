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
  /**
   * Model-specific concrete pi-side provider overrides for synthetic
   * `pi-fork/<model>` requests. This keeps `pi-fork/claude-*` on
   * `claude-bridge` while allowing `pi-fork/gpt-5.5` to stay inside the
   * pi-fork harness and route to `openai-codex` under the hood.
   */
  downstreamProvidersByModel?: Record<string, string>;
  /**
   * Default thinking level written to the spawned pi agent's settings.json.
   * Models that only support adaptive thinking (e.g. claude-fable-5) reject
   * `thinking: {type: "disabled"}` — pi sends that when the level is "off" —
   * so set `"adaptive"` when routing such models through pi-fork (ISSUE-140).
   * Default: `"off"` (previous hardcoded behavior).
   */
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";
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
   * Normally-deferred native pi tools that this pi-fork profile should expose as
   * full provider-visible schemas. Defaults to TaskBackgroundList/TaskStop so
   * Anthropic never sees a tool_reference for a task utility that is absent from
   * the final tools[] list.
   */
  nativeToolEager?: string[];
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
