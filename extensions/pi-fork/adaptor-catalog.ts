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
 * This module can end up bundled into a shared tsdown/rolldown chunk at an
 * unpredictable depth under dist/ — confirmed live: adaptor-catalog.ts's own
 * compiled output re-exports from a shared dist/adaptor-catalog-<hash>.js
 * chunk sitting directly under dist/, not the dist/extensions/pi-fork/*.js
 * location its source path would naively suggest. A fixed-depth resolve()
 * from this file's own import.meta.url is therefore not safe (this was
 * tried first and shipped a version that silently never found either MCP
 * server in a real build). Instead this walks upward from wherever the
 * module actually loaded from, looking for OpenClaw's own package.json
 * (name "openclaw") as a stable marker, then derives dist/mcp/ from there.
 * extensions/acpx/src/config.ts solves the identical "find dist/mcp/*.js
 * from inside a bundled extension" problem with an analogous walk-up +
 * marker-check approach; this mirrors that proven pattern locally rather
 * than importing across extensions. Every lookup here still existence-
 * checks first and degrades to an empty catalog rather than throwing, so a
 * pre-rebuild image or an unbuilt source checkout simply yields no bridged
 * tools instead of a wrong-path crash.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** One resolved OpenClaw tool, matching PiHarnessConfig["adaptorTools"][number]. */
export type AdaptorToolSpec = {
  name: string;
  server: string;
  tool: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type AdaptorCatalogConfig = {
  adaptorTools?: AdaptorToolSpec[];
};

export type McpServerSpec = {
  /** mcporter/adaptor server id — becomes the `oc__<server>__<tool>` prefix. */
  id: string;
  /** Absolute path to the compiled MCP stdio server script. */
  scriptPath: string;
};

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Walks upward from `startDir` looking for OpenClaw's own package.json
 * (name "openclaw") to reliably locate the app root regardless of where a
 * bundler happened to place this module's compiled chunk. Returns undefined
 * if no such marker is found within a generous bound — should never happen
 * inside a real OpenClaw checkout or built image, but callers must not
 * assume this always resolves.
 */
function findOpenClawAppRoot(startDir: string): string | undefined {
  let cursor = startDir;
  for (let i = 0; i < 10; i += 1) {
    const pkgPath = join(cursor, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
        };
        if (pkg.name === "openclaw") {
          return cursor;
        }
      } catch {
        // Not JSON, or an unrelated package.json — keep walking upward.
      }
    }
    const parent = resolve(cursor, "..");
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return undefined;
}

// The mcp server scripts need APP_ROOT as their spawn cwd or module
// resolution fails (verified live: the wrong cwd throws ERR_MODULE_NOT_FOUND
// for transitive deps). Falls back to the old fixed-depth guess if no
// "openclaw" package.json is found (harmless: every caller existence-guards
// before using these paths) — kept only as a last-resort, not expected to
// ever be exercised in a real checkout or image.
const APP_ROOT = findOpenClawAppRoot(THIS_DIR) ?? resolve(THIS_DIR, "../../../");
const MCP_DIR = join(APP_ROOT, "dist", "mcp");

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
  const client = new Client({
    name: "openclaw-pi-fork-adaptor-catalog",
    version: "1.0.0",
  });
  try {
    await client.connect(transport, { timeout: CATALOG_QUERY_TIMEOUT_MS });
    const { tools } = await client.listTools(undefined, {
      timeout: CATALOG_QUERY_TIMEOUT_MS,
    });
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
  config: AdaptorCatalogConfig,
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
