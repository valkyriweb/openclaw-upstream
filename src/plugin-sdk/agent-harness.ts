// Public agent harness surface for plugins that replace the low-level agent runtime.
// Keep model/vendor-specific protocol code in the plugin that registers the harness.

export * from "./agent-harness-runtime.js";
export { createOpenClawCodingTools } from "../agents/agent-tools.js";
export { resolveWebSearchToolPolicy } from "../agents/web-search-tool-policy.js";
// Canonical tool-identity resolver shared by every runtime (embedded, Codex
// app-server, spawned pi-fork). Runtimes that filter a `toolsAllow` list MUST
// resolve names through this instead of re-declaring their own normalizer, so
// namespaced entries (e.g. `openclaw.web_search`) reconcile identically.
export {
  KNOWN_TOOL_NAMESPACE_PREFIXES,
  normalizeToolName,
  OPENCLAW_TOOL_NAMESPACE,
} from "../agents/tool-policy-shared.js";
