/**
 * Shared runtime tool policy normalization.
 *
 * Keeps aliases, groups, profile expansion, and prefix matching consistent across allow/deny paths.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  CORE_TOOL_GROUPS,
  resolveCoreToolProfilePolicy,
  type ToolProfileId,
} from "./tool-catalog.js";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

/**
 * Canonical namespace for OpenClaw-owned tools. Tool identity is structurally
 * `{namespace, name}` — e.g. the Codex runtime tags OpenClaw dynamic tools with
 * this namespace, and providers expose them inside the `functions` call
 * container. Kept here as the single source of truth so runtimes that need the
 * namespace (Codex app-server, spawned pi-fork adaptor) import it instead of
 * re-declaring it.
 */
export const OPENCLAW_TOOL_NAMESPACE = "openclaw";

/**
 * Flattened runtime tool namespaces whose dotted `<namespace>.<tool>` string is
 * a serialized view of the structural `{namespace, name}` identity. When that
 * form leaks into a policy list (e.g. a cron `toolsAllow` authored as
 * `openclaw.web_search` / `functions.message`), the namespace segment must be
 * reconciled back to the bare tool id used for matching. Real tool ids never
 * contain "." and MCP/plugin tools use the "__" separator, so a known-namespace
 * dotted prefix is unambiguous to strip.
 */
export const KNOWN_TOOL_NAMESPACE_PREFIXES: ReadonlySet<string> = new Set([
  OPENCLAW_TOOL_NAMESPACE,
  "functions",
]);

/** Peels flattened `<namespace>.` prefixes (e.g. `openclaw.`/`functions.`) off a tool id. */
function stripKnownToolNamespacePrefix(folded: string): string {
  let current = folded;
  for (;;) {
    const dot = current.indexOf(".");
    if (dot <= 0 || !KNOWN_TOOL_NAMESPACE_PREFIXES.has(current.slice(0, dot))) {
      return current;
    }
    const rest = current.slice(dot + 1);
    if (!rest) {
      return current;
    }
    current = rest;
  }
}

/** Core tool groups exposed to allow/deny policy config. */
export const TOOL_GROUPS: Record<string, string[]> = { ...CORE_TOOL_GROUPS };

/** Normalizes a tool name or alias to the policy id used for matching. */
export function normalizeToolName(name: string) {
  const folded = normalizeLowercaseStringOrEmpty(name);
  const deNamespaced = stripKnownToolNamespacePrefix(folded);
  return TOOL_NAME_ALIASES[deNamespaced] ?? deNamespaced;
}

/** Checks whether an in-progress prefix can still resolve to an allowed tool or alias. */
export function couldNormalizeToolNamePrefixToAllowedTool(
  prefix: string,
  allowedToolNames: Set<string>,
): boolean {
  const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
  if (!normalizedPrefix) {
    return false;
  }

  const allowed = new Set<string>();
  for (const toolName of allowedToolNames) {
    const normalizedToolName = normalizeToolName(toolName);
    const foldedToolName = normalizeLowercaseStringOrEmpty(toolName);
    if (normalizedToolName) {
      allowed.add(normalizedToolName);
    }
    if (foldedToolName) {
      allowed.add(foldedToolName);
    }
    if (
      normalizedToolName.startsWith(normalizedPrefix) ||
      foldedToolName.startsWith(normalizedPrefix)
    ) {
      return true;
    }
  }

  const resolvedPrefix = normalizeToolName(normalizedPrefix);
  if (resolvedPrefix !== normalizedPrefix) {
    for (const toolName of allowed) {
      if (toolName.startsWith(resolvedPrefix)) {
        return true;
      }
    }
  }

  for (const [alias, toolName] of Object.entries(TOOL_NAME_ALIASES)) {
    if (alias.startsWith(normalizedPrefix) && allowed.has(toolName)) {
      return true;
    }
  }
  return false;
}

/** Normalizes a configured allow/deny list while dropping blank entries. */
export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

/** Expands named tool groups into concrete tool ids. */
export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return uniqueStrings(expanded);
}

/** Resolves a built-in tool profile policy by id. */
export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  return resolveCoreToolProfilePolicy(profile);
}

export type { ToolProfileId };
