/**
 * Regression coverage for core tool allow/deny policy helpers.
 * Verifies sandbox policy resolution, explicit lists, and tool matching.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import {
  collectExplicitAllowlist,
  DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  expandToolGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("read");
    expect(coding?.allow).toContain("cron");
    expect(coding?.allow).not.toContain("gateway");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("subagents");
    expect(group).toContain("session_status");
    expect(group).toContain("tts");
  });

  it("normalizes tool names and aliases", () => {
    expect(normalizeToolName(" BASH ")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName("READ")).toBe("read");
  });

  it("resolves flattened tool namespaces to bare policy ids (ISSUE-171)", () => {
    // `openclaw.`/`functions.` are serialized views of the structural
    // {namespace, name} tool identity; policy matching needs the bare id.
    expect(normalizeToolName("openclaw.web_search")).toBe("web_search");
    expect(normalizeToolName("openclaw.web_fetch")).toBe("web_fetch");
    expect(normalizeToolName("functions.message")).toBe("message");
    expect(normalizeToolName("openclaw.cron")).toBe("cron");
    // Namespace strip composes with alias mapping.
    expect(normalizeToolName("openclaw.bash")).toBe("exec");
    expect(normalizeToolName("functions.apply-patch")).toBe("apply_patch");
    // Bare ids and MCP/plugin `__` names are never falsely stripped.
    expect(normalizeToolName("web_search")).toBe("web_search");
    expect(normalizeToolName("firecrawl__scrape")).toBe("firecrawl__scrape");
    // Unknown namespaces are left intact (only known prefixes strip).
    expect(normalizeToolName("mcp.foo")).toBe("mcp.foo");
    // Straggler entries de-namespace correctly even when the bare id is not a
    // core tool (exec_command vs exec, firecrawl_scrape vs firecrawl__scrape);
    // the fail-loud guard, not the resolver, surfaces those mismatches.
    expect(normalizeToolName("functions.exec_command")).toBe("exec_command");
    expect(normalizeToolName("openclaw.firecrawl_scrape")).toBe("firecrawl_scrape");
  });

  it("collects explicit allowlist entries", () => {
    expect(
      collectExplicitAllowlist([
        {
          allow: ["*", "optional-demo"],
        },
      ]),
    ).toContain("optional-demo");
  });

  it("uses alsoAllow entries for plugin discovery without the synthetic allow-all", () => {
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: ["lobster"] })])).toEqual([
      "lobster",
      DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
    ]);
    expect(
      collectExplicitAllowlist([pickSandboxToolPolicy({ allow: [], alsoAllow: ["lobster"] })]),
    ).toEqual(["*", "lobster"]);
  });

  it("preserves explicit alsoAllow wildcards for plugin discovery", () => {
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: ["*"] })])).toEqual(["*"]);
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: [" * "] })])).toEqual([
      "*",
    ]);
  });
});

describe("sandbox tool policy", () => {
  it("allows all tools with * allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: [] };
    expect(isToolAllowed(policy, "browser")).toBe(true);
  });

  it("denies all tools with * deny", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["*"] };
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("supports wildcard patterns", () => {
    const policy: SandboxToolPolicy = { allow: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(true);
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("applies deny before allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("treats empty allowlist as allow-all (with deny exceptions)", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("expands tool groups + aliases in patterns", () => {
    const policy: SandboxToolPolicy = {
      allow: ["group:fs", "BASH"],
      deny: ["apply_*"],
    };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "exec")).toBe(true);
    expect(isToolAllowed(policy, "apply_patch")).toBe(false);
  });

  it("normalizes whitespace + case", () => {
    const policy: SandboxToolPolicy = { allow: [" WEB_* "] };
    expect(isToolAllowed(policy, "WEB_FETCH")).toBe(true);
  });
});

describe("resolveSandboxToolPolicyForAgent", () => {
  it("keeps allow-all semantics when allow is []", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: [], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.sources.allow).toEqual({
      source: "global",
      key: "tools.sandbox.tools.allow",
    });
    expect(resolved.allow).toStrictEqual([]);
    expect(resolved.deny).toEqual(["browser"]);

    const policy: SandboxToolPolicy = { allow: resolved.allow, deny: resolved.deny };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "browser")).toBe(false);
  });

  it("auto-adds image to explicit allowlists unless denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read", "image"]);
    expect(resolved.deny).toEqual(["browser"]);
  });

  it("does not auto-add image when explicitly denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["image"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read"]);
    expect(resolved.deny).toEqual(["image"]);
  });
});

describe("isToolAllowedByPolicyName — apply_patch / write deny decoupling (#76749)", () => {
  it("does not deny apply_patch when write is denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write"] })).toBe(true);
  });

  it("still denies apply_patch when apply_patch is explicitly denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["apply_patch"] })).toBe(false);
  });

  it("still allows apply_patch via write in the allow list", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["write"], deny: [] })).toBe(true);
  });

  it("denies apply_patch when both write and apply_patch are denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write", "apply_patch"] })).toBe(
      false,
    );
  });
});

describe("runtime toolsAllow namespace resolution (ISSUE-171 regression)", () => {
  // Hill's cron authored tool names in their flattened provider/namespace form.
  // Pre-fix these resolved to zero callable tools ("No callable tools remain");
  // post-fix the entries that map to real tool ids resolve and are allowed.
  const HILL_TOOLS_ALLOW = [
    "openclaw.web_search",
    "openclaw.web_fetch",
    "openclaw.firecrawl_scrape",
    "functions.message",
    "functions.exec_command",
    "functions.apply_patch",
    "openclaw.cron",
  ];

  it("allows namespaced entries that map to real tool ids", () => {
    const policy: SandboxToolPolicy = { allow: HILL_TOOLS_ALLOW, deny: [] };
    for (const tool of ["web_search", "web_fetch", "message", "apply_patch", "cron"]) {
      expect(isToolAllowedByPolicyName(tool, policy)).toBe(true);
    }
  });

  it("keeps the allowlist restrictive for tools it does not list", () => {
    const policy: SandboxToolPolicy = { allow: HILL_TOOLS_ALLOW, deny: [] };
    expect(isToolAllowedByPolicyName("read", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("write", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("gateway", policy)).toBe(false);
  });
});
