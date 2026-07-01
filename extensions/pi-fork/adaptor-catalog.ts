/**
 * Resolves the live OpenClaw tool catalog (plugin-registered tools + curated
 * built-ins) into the shape the my-pi openclaw-adaptor extension consumes,
 * plus the mcporter stdio server entries needed to reach them from inside a
 * spawned pi-fork process (ISSUE-165).
 *
 * WHY THIS QUERIES OVER MCP INSTEAD OF IMPORTING SRC DIRECTLY
 * `extensions/` is a separate TypeScript project from `src/`
 * (tsconfig.extensions.json only includes `src/**\/*.d.ts`, never `src/`
 * runtime code — every existing extensions/pi-fork/*.ts import into OpenClaw
 * internals goes through the published `openclaw/plugin-sdk/*` surface).
 * Rather than grow that ~300-export surface for a single internal consumer,
 * this reuses the two MCP stdio servers OpenClaw already ships and deploys
 * for the ACP/Claude Code tool bridge (mcp/plugin-tools-serve.ts,
 * mcp/openclaw-tools-serve.ts): spawn each briefly, ask tools/list over the
 * official MCP client SDK, done. This is the same mechanism mcporter itself
 * uses to reach these servers at tool-call time (verified live against the
 * lue-kube gateway pod before writing this file).
 *
 * COST
 * One short-lived subprocess per server, only when computing the catalog —
 * which happens once per NEW pi-fork process bind. session-binding.ts's
 * getOrCreatePiProcess caches and reuses the spawned pi process across turns
 * for the same session/model/workspace, so this is not a per-turn cost.
 *
 * PATH RESOLUTION
 * mcp/ and extensions/pi-fork/ compile to sibling directories under the
 * built container's dist/ (dist/mcp/*.js, dist/extensions/pi-fork/*.js —
 * confirmed live), so resolving relative to this file's own import.meta.url
 * needs no container-vs-dev path table. This does NOT hold for the raw
 * TypeScript source tree (src/mcp/*.ts vs extensions/pi-fork/*.ts are not
 * symmetric siblings pre-build) — that's fine, because every lookup here
 * existence-checks first and degrades to an empty catalog rather than
 * throwing, so running from source (tests, ad-hoc dev) simply yields no
 * bridged tools instead of a wrong path crash.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PiHarnessConfig } from "./config.js";

/** One resolved OpenClaw tool, matching PiHarnessConfig["adaptorTools"][number]. */
export type AdaptorToolSpec = {
  name: string;
  server: string;
  tool: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpServerSpec = {
  /** mcporter/adaptor server id — becomes the `oc__<server>__<tool>` prefix. */
  id: string;
  /** Absolute path to the compiled MCP stdio server script. */
  scriptPath: string;
};

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = resolve(THIS_DIR, "../../mcp");
// The OpenClaw app root is two levels above mcp/ — where node_modules and
// package.json live. The mcp server scripts need this as their spawn cwd or
// module resolution fails (verified live: the wrong cwd throws
// ERR_MODULE_NOT_FOUND for transitive deps).
const APP_ROOT = resolve(MCP_DIR, "../../");

const PLUGIN_TOOLS_SERVER: McpServerSpec = {
  id: "openclaw-plugin-tools",
  scriptPath: join(MCP_DIR, "plugin-tools-serve.js"),
};
const BUILTIN_TOOLS_SERVER: McpServerSpec = {
  id: "openclaw-tools",
  scriptPath: join(MCP_DIR, "openclaw-tools-serve.js"),
};
const ALL_SERVERS: McpServerSpec[] = [PLUGIN_TOOLS_SERVER, BUILTIN_TOOLS_SERVER];

/** Bounds connect+listTools so a hung/misbehaving MCP server can never block a pi-fork spawn. */
const CATALOG_QUERY_TIMEOUT_MS = 10_000;

/**
 * Tools that clash/overlap with a pi-native tool the spawned pi already has
 * (bash, read/write/edit/grep/Glob/Ls, web_fetch/web_search,
 * TaskBackgroundList/TaskStop) — pi's own native tool wins, so these are held
 * back from the bridged catalog. Currently empty: the live 75-tool plugin
 * catalog (+ cron once openclaw-tools ships) has no exact functional
 * duplicate of a pi-native tool. `memory_get` (bounded excerpt read) and
 * `code_execution` (remote sandboxed Python, not local bash) are soft,
 * non-duplicate overlaps kept in by default per the approved ISSUE-165 plan.
 */
const EXCLUDED_TOOL_NAMES = new Set<string>([]);

/**
 * Spawns one MCP stdio server briefly and returns its tool catalog, prefixed
 * and shaped for PiHarnessConfig["adaptorTools"]. Never throws: a missing
 * script, a spawn failure, or a protocol error all degrade to `[]` — a
 * broken or not-yet-deployed bridge server must never block a pi-fork spawn.
 */
export async function listToolsFromServer(server: McpServerSpec): Promise<AdaptorToolSpec[]> {
  if (!existsSync(server.scriptPath)) {
    return [];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server.scriptPath],
    cwd: APP_ROOT,
    // These are OpenClaw's own already-vetted internals, spawned at the same
    // trust level as this caller (not a third-party MCP server) — the SDK's
    // restrictive default env (HOME/LOGNAME/PATH/SHELL/TERM/USER only) would
    // starve the server's getRuntimeConfig() of whatever else the gateway
    // process env carries.
    env: process.env as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "openclaw-pi-fork-adaptor-catalog", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: CATALOG_QUERY_TIMEOUT_MS });
    const { tools } = await client.listTools(undefined, { timeout: CATALOG_QUERY_TIMEOUT_MS });
    return tools
      .filter((tool) => !EXCLUDED_TOOL_NAMES.has(tool.name))
      .map((tool) => ({
        name: `oc__${server.id}__${tool.name}`,
        server: server.id,
        tool: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      }));
  } catch (err) {
    process.stderr.write(
      `pi-fork adaptor-catalog: ${server.id} tools/list failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return [];
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Resolves the adaptorTools catalog: an explicit non-empty
 * `config.adaptorTools` wins as a manual override/escape hatch (pinning,
 * testing); otherwise queries both OpenClaw MCP tool servers live and
 * flattens the results.
 */
export async function resolveAdaptorToolsCatalog(
  config: PiHarnessConfig,
): Promise<AdaptorToolSpec[]> {
  if (Array.isArray(config.adaptorTools) && config.adaptorTools.length > 0) {
    return config.adaptorTools;
  }
  const results = await Promise.allSettled(
    ALL_SERVERS.map((server) => listToolsFromServer(server)),
  );
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

/**
 * mcporter stdio server entries for whichever adaptor MCP servers are
 * deployed in this image (existence-checked, so a pre-rebuild image missing
 * openclaw-tools-serve.js simply omits that one entry).
 */
export function resolveAdaptorMcpServerEntries(
  servers: McpServerSpec[] = ALL_SERVERS,
): Record<string, { command: string; args: string[]; cwd: string }> {
  const entries: Record<string, { command: string; args: string[]; cwd: string }> = {};
  for (const server of servers) {
    if (existsSync(server.scriptPath)) {
      entries[server.id] = {
        command: process.execPath,
        args: [server.scriptPath],
        cwd: APP_ROOT,
      };
    }
  }
  return entries;
}
