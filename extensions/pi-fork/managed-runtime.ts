import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { PiHarnessConfig } from "./config.js";

type OpenClawAuthProfile = {
  type?: string;
  provider?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  email?: string;
};

const openClawHome = process.env.OPENCLAW_HOME || `${process.env.HOME}/.openclaw`;
const DEFAULT_RUNTIME_DIR = `${openClawHome}/pi-mono-fork`;
const DEFAULT_PI_AGENT_DIR = `${openClawHome}/pi-fork-agent`;
const DEFAULT_PI_AUTH_PATH = `${DEFAULT_PI_AGENT_DIR}/auth.json`;
const DEFAULT_SOURCE_PI_MODELS_PATH = `${process.env.HOME}/.pi/agent/models.json`;
const DEFAULT_CONTAINER_MY_PI_HARNESS_PACKAGE =
  "/opt/openclaw-custom/source-overlay/my-pi/packages/my-pi-harness";
const DEFAULT_MY_PI_HARNESS_PACKAGE = `${process.env.HOME}/Projects/personal/my-pi/packages/my-pi-harness`;
const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api";
// Shared ChatGPT-subscription (Codex backend) catalog. Both the `openai-codex`
// and `openai` provider ids point here so model strings `openai-codex/<id>` and
// `openai/<id>` both resolve. Auth is OAuth from auth.json — no apiKey field —
// and the `openai` provider reuses the synced `openai-codex` OAuth via pi's
// provider-candidate fallback (resolveAuthProviderCandidates: openai → openai-codex).
const CODEX_OAUTH_MODELS = [
  { id: "gpt-5.5", name: "GPT-5.5 (ChatGPT)" },
  { id: "gpt-5.4", name: "GPT-5.4 (ChatGPT)" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (ChatGPT)" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex (ChatGPT)" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex (ChatGPT)" },
  { id: "gpt-5.2", name: "GPT-5.2 (ChatGPT)" },
].map((m) => ({
  ...m,
  contextWindow: 272000,
  maxTokens: 128000,
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));
const DEFAULT_PI_HARNESS_MODELS = {
  providers: {
    "claude-bridge": {
      baseUrl: "http://127.0.0.1:9100",
      api: "anthropic-messages",
      apiKey: "sk-ant-oat-bridge-local",
      models: [
        {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8 1M (Bridge)",
          contextWindow: 1000000,
          maxTokens: 128000,
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            adaptive: "adaptive",
          },
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
    "openai-codex": {
      baseUrl: CODEX_RESPONSES_BASE_URL,
      api: "openai-codex-responses",
      models: CODEX_OAUTH_MODELS,
    },
    openai: {
      baseUrl: CODEX_RESPONSES_BASE_URL,
      api: "openai-codex-responses",
      models: CODEX_OAUTH_MODELS,
    },
  },
};
const DEFAULT_AUTH_PROFILES_PATH = `${openClawHome}/agents/main/agent/auth-profiles.json`;
const localRequire = createRequire(import.meta.url);

function run(command: string, args: string[], cwd?: string): void {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env },
  });
}

function copySource(sourceDir: string, installDir: string): void {
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(dirname(installDir), { recursive: true });
  run("cp", ["-a", `${sourceDir}/.`, installDir]);
}

function cloneSource(source: string, ref: string | undefined, installDir: string): void {
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(dirname(installDir), { recursive: true });
  run("git", ["clone", ...(ref ? ["--branch", ref] : []), "--depth", "1", source, installDir]);
}

function writeLauncher(runtimeDir: string): string {
  const launcher = join(runtimeDir, "pi");
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec node "${join(runtimeDir, "packages/coding-agent/dist/cli.js")}" "$@"\n`,
    { mode: 0o755 },
  );
  return launcher;
}

function syncOpenAiCodexAuth(config: PiHarnessConfig): void {
  const sourcePath = config.authProfilesPath ?? DEFAULT_AUTH_PROFILES_PATH;
  const targetPath = config.piAuthPath ?? DEFAULT_PI_AUTH_PATH;
  if (!existsSync(sourcePath)) {
    return;
  }
  const profiles = JSON.parse(readFileSync(sourcePath, "utf8")) as {
    profiles?: Record<string, OpenClawAuthProfile>;
  };
  // ChatGPT Codex OAuth lands under either provider id depending on how the
  // profile was created: native `openai-codex:*` or `openai:*` (which pi's
  // resolveAuthProviderCandidates maps openai → openai-codex). Accept both, then
  // sync the FRESHEST one: the most recently refreshed profile carries the newest
  // refresh token. OpenClaw rotates the refresh token on every refresh, so an
  // older profile's refresh token may already be invalidated — picking max(expires)
  // hands the inner pi a live refresh token it can self-refresh from on expiry.
  const profile = Object.values(profiles.profiles ?? {})
    .filter(
      (entry) =>
        entry?.type === "oauth" &&
        (entry.provider === "openai-codex" || entry.provider === "openai") &&
        entry.access &&
        entry.refresh,
    )
    .sort((a, b) => (b.expires ?? 0) - (a.expires ?? 0))[0];
  if (!profile) {
    return;
  }
  const existing = existsSync(targetPath)
    ? (JSON.parse(readFileSync(targetPath, "utf8") || "{}") as Record<string, unknown>)
    : {};
  existing["openai-codex"] = {
    type: "oauth",
    access: profile.access,
    refresh: profile.refresh,
    expires: profile.expires,
    accountId: profile.accountId,
    email: profile.email,
  };
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Static, cache-stable config object for my-pi extensions in the spawned pi.
 *
 * OpenClaw owns these catalogs in-process, so it serializes them synchronously
 * into settings.json at spawn (no async tools/list handshake, deterministic
 * lex-sorted ordering). Read by native-tool-overrides + openclaw-adaptor.
 */
function buildPiHarnessExtensionSettings(config: PiHarnessConfig): Record<string, unknown> {
  const exclude = config.nativeToolExclude ?? ["Agent"];
  const settings: Record<string, unknown> = {
    "native-tool-overrides": { exclude },
  };

  const tools = Array.isArray(config.adaptorTools)
    ? config.adaptorTools
        .filter(
          (t) =>
            t &&
            typeof t.name === "string" &&
            typeof t.server === "string" &&
            typeof t.tool === "string",
        )
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  if (tools.length > 0) {
    settings["openclaw-adaptor"] = {
      tools,
      ...(config.adaptorExec ? { exec: config.adaptorExec } : {}),
      ...(typeof config.adaptorTimeoutMs === "number"
        ? { timeoutMs: config.adaptorTimeoutMs }
        : {}),
    };
  }
  return settings;
}

export function resolvePiAgentDir(config: PiHarnessConfig): string {
  if (config.piAgentDir?.trim()) {
    return config.piAgentDir;
  }
  return dirname(config.piAuthPath ?? DEFAULT_PI_AUTH_PATH);
}

export function resolveMyPiHarnessPackage(config: PiHarnessConfig): string | undefined {
  const configured = config.myPiHarnessPackagePath ?? process.env.MY_PI_HARNESS_PACKAGE;
  if (configured?.trim()) {
    return resolve(configured);
  }
  if (existsSync(DEFAULT_CONTAINER_MY_PI_HARNESS_PACKAGE)) {
    return DEFAULT_CONTAINER_MY_PI_HARNESS_PACKAGE;
  }
  return existsSync(DEFAULT_MY_PI_HARNESS_PACKAGE) ? DEFAULT_MY_PI_HARNESS_PACKAGE : undefined;
}

export function ensurePiHarnessAgentSettings(config: PiHarnessConfig): string {
  const agentDir = resolvePiAgentDir(config);
  const packagePath = resolveMyPiHarnessPackage(config);
  if (!packagePath) {
    throw new Error(
      "my-pi-harness package not found; set plugins.config.pi-fork.myPiHarnessPackagePath or MY_PI_HARNESS_PACKAGE",
    );
  }
  mkdirSync(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        defaultProvider: "claude-bridge",
        defaultModel: "claude-opus-4-8",
        defaultThinkingLevel: config.defaultThinkingLevel ?? "off",
        enabledModels: ["claude-bridge/*", "openai-codex/*", "openai/*"],
        packages: [packagePath],
        extensions: buildPiHarnessExtensionSettings(config),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  const targetModelsPath = join(agentDir, "models.json");
  if (existsSync(DEFAULT_SOURCE_PI_MODELS_PATH)) {
    // Dev: seed once from the developer's curated pi catalog; never clobber it.
    if (!existsSync(targetModelsPath)) {
      copyFileSync(DEFAULT_SOURCE_PI_MODELS_PATH, targetModelsPath);
    }
  } else {
    // Container: the catalog is fully managed — refresh every spawn so model
    // upgrades and new providers (openai-codex/openai) always propagate instead
    // of being pinned by a stale only-if-absent write.
    writeFileSync(targetModelsPath, JSON.stringify(DEFAULT_PI_HARNESS_MODELS, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return settingsPath;
}

function replaceOnce(text: string, target: string, replacement: string): string {
  const first = text.indexOf(target);
  if (first === -1 || text.slice(first + target.length).includes(target)) {
    throw new Error("tokenjuice runtime shape changed; expected exactly one patch target");
  }
  return `${text.slice(0, first)}${replacement}${text.slice(first + target.length)}`;
}

function patchTokenjuiceRuntimeForCodexTools(source: string): string {
  if (source.includes("function extractCodexCommand(event, outputText)")) {
    return source;
  }

  let patched = replaceOnce(
    source,
    'function stripPiBashEpilogue(text) {\n  return text.replace(/\\n\\nCommand exited with code \\d+\\s*$/u, "").replace(/\\n\\nCommand timed out after \\d+ seconds\\s*$/u, "").replace(/\\n\\nCommand aborted\\s*$/u, "");\n}\n',
    'function stripPiBashEpilogue(text) {\n  return text.replace(/\\n\\nCommand exited with code \\d+\\s*$/u, "").replace(/\\n\\nCommand timed out after \\d+ seconds\\s*$/u, "").replace(/\\n\\nCommand aborted\\s*$/u, "");\n}\nfunction extractCodexCommand(event, outputText) {\n  if (isRecord2(event.input) && typeof event.input.cmd === "string") {\n    return event.input.cmd;\n  }\n  const match = outputText.match(/^Command: (.*)$/mu);\n  return match?.[1] ?? "";\n}\nfunction extractCodexVisibleText(event, outputText) {\n  if (isRecord2(event.details) && typeof event.details.output === "string") {\n    return event.details.output;\n  }\n  const marker = "\\nOutput:\\n";\n  const markerIndex = outputText.indexOf(marker);\n  return markerIndex === -1 ? outputText : outputText.slice(markerIndex + marker.length);\n}\nfunction extractCodexExitCode(event, isError) {\n  if (isRecord2(event.details) && typeof event.details.exit_code === "number") {\n    return event.details.exit_code;\n  }\n  const text = extractTextContent(event.content);\n  const match = text.match(/Process exited with code (-?\\d+)/u);\n  if (match?.[1]) {\n    return Number(match[1]);\n  }\n  return isError ? 1 : 0;\n}\n',
  );
  patched = replaceOnce(
    patched,
    '      if (event.toolName !== "bash") {\n        return void 0;\n      }',
    '      const isCodexExecTool = event.toolName === "exec_command" || event.toolName === "write_stdin";\n      if (event.toolName !== "bash" && !isCodexExecTool) {\n        return void 0;\n      }',
  );
  patched = replaceOnce(
    patched,
    '      const command = isRecord2(event.input) && typeof event.input.command === "string" ? event.input.command : "";\n      if (!enabled || !autoCompactEnabled || !command) {\n        return void 0;\n      }\n      const outputText = extractTextContent(event.content);',
    '      const outputText = extractTextContent(event.content);\n      const command = isRecord2(event.input) && typeof event.input.command === "string" ? event.input.command : isCodexExecTool ? extractCodexCommand(event, outputText) : "";\n      if (!enabled || !autoCompactEnabled || !command) {\n        return void 0;\n      }',
  );
  return replaceOnce(
    patched,
    "      const exitCode = parseExitCode(outputText, Boolean(event.isError));\n      const visibleText = stripPiBashEpilogue(outputText);",
    "      const exitCode = isCodexExecTool ? extractCodexExitCode(event, Boolean(event.isError)) : parseExitCode(outputText, Boolean(event.isError));\n      const visibleText = isCodexExecTool ? extractCodexVisibleText(event, outputText) : stripPiBashEpilogue(outputText);",
  );
}

export function ensureTokenjuicePiExtension(config: PiHarnessConfig): string | undefined {
  let tokenjuiceRoot: string | undefined;
  let tokenjuiceRuntime: string | undefined;
  const resolvers = [
    localRequire,
    createRequire(join(process.cwd(), "package.json")),
    createRequire("/app/package.json"),
  ];
  for (const resolveFrom of resolvers) {
    try {
      tokenjuiceRoot = dirname(dirname(resolveFrom.resolve("tokenjuice")));
      tokenjuiceRuntime = join(tokenjuiceRoot, "dist/hosts/pi/extension/runtime.js");
      break;
    } catch {
      // Try the next resolver.
    }
  }
  if (!tokenjuiceRoot || !tokenjuiceRuntime) {
    return undefined;
  }

  const version = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(tokenjuiceRoot, "package.json"), "utf8")) as {
        version?: unknown;
      };
      return typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      return "unknown";
    }
  })();
  const runtimeSource = (() => {
    try {
      return patchTokenjuiceRuntimeForCodexTools(readFileSync(tokenjuiceRuntime, "utf8"));
    } catch {
      return undefined;
    }
  })();
  if (!runtimeSource) {
    return undefined;
  }

  const extensionsDir = join(resolvePiAgentDir(config), "extensions");
  const extensionPath = join(extensionsDir, "tokenjuice.js");
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(
    extensionPath,
    [
      "/**",
      " * tokenjuice pi extension",
      ` * generated by OpenClaw pi-fork from tokenjuice v${version}`,
      " */",
      "",
      runtimeSource,
      "",
      "const config = {",
      '  "extensionCommand": "tj"',
      "};",
      "",
      "export default createTokenjuicePiExtension(config);",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return extensionPath;
}

function ensureWorkspaceLinks(runtimeDir: string): void {
  const nodeModules = join(runtimeDir, "node_modules");
  const scopeDir = join(nodeModules, "@earendil-works");
  mkdirSync(scopeDir, { recursive: true });
  const links: Record<string, string> = {
    "pi-ai": "../../packages/ai",
    "pi-agent-core": "../../packages/agent",
    "pi-tui": "../../packages/tui",
    "pi-coding-agent": "../../packages/coding-agent",
  };
  for (const [name, target] of Object.entries(links)) {
    const link = join(scopeDir, name);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
}

export function ensureManagedPiRuntime(config: PiHarnessConfig): string | undefined {
  syncOpenAiCodexAuth(config);
  ensureTokenjuicePiExtension(config);

  const source = config.piMonoForkSource;
  if (!source) {
    return undefined;
  }

  const runtimeDir = config.piMonoForkRuntimeDir ?? DEFAULT_RUNTIME_DIR;
  const cliPath = join(runtimeDir, "packages/coding-agent/dist/cli.js");
  const shouldInstall = config.piMonoForkAutoInstall !== false;

  if (!existsSync(cliPath)) {
    if (!shouldInstall) {
      throw new Error(
        `pi-mono-fork runtime missing at ${cliPath}; enable piMonoForkAutoInstall or set command`,
      );
    }
    if (existsSync(source)) {
      copySource(source, runtimeDir);
    } else {
      cloneSource(source, config.piMonoForkRef, runtimeDir);
    }
    run("npm", ["install"], runtimeDir);
    run("npm", ["run", "build"], runtimeDir);
  }

  ensureWorkspaceLinks(runtimeDir);
  return writeLauncher(runtimeDir);
}
