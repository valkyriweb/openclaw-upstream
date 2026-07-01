/**
 * Pi RPC process binding — one long-lived pi process per OpenClaw session.
 *
 * Keeps a map of OpenClaw sessionId → PiRpcProcess so turns within the same
 * conversation share a single pi session (preserving history, compaction state,
 * and pi's own tool context).
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PiHarnessConfig } from "./config.js";
import { resolvePiCommand } from "./config.js";
import {
  ensureAdaptorMcpServers,
  ensurePiHarnessAgentSettings,
  resolvePiAgentDir,
} from "./managed-runtime.js";

const STDERR_TAIL_MAX_LINES = 50;
const STDERR_TAIL_MAX_LINE_CHARS = 500;
const PARSE_ERROR_LOG_LIMIT = 5;
const KILL_ESCALATION_MS = 3_000;
const DEFAULT_DOWNSTREAM_PROVIDER = "claude-bridge";
const DEFAULT_CODEX_DOWNSTREAM_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
]);

async function resolvePiAgentEnv(
  config: PiHarnessConfig,
  workspaceDir: string,
): Promise<NodeJS.ProcessEnv> {
  await ensurePiHarnessAgentSettings(config);
  ensureAdaptorMcpServers(workspaceDir);
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: resolvePiAgentDir(config),
  };
}

export type PiRpcSendFn = (obj: unknown) => void;

export function resolvePiRpcProvider(opts: {
  config: PiHarnessConfig;
  provider?: string;
  modelId?: string;
}): string | undefined {
  if (opts.provider !== "pi-fork") {
    return opts.provider;
  }
  const configured = opts.modelId
    ? opts.config.downstreamProvidersByModel?.[opts.modelId]
    : undefined;
  if (configured?.trim()) {
    return configured.trim();
  }
  if (opts.modelId && DEFAULT_CODEX_DOWNSTREAM_MODELS.has(opts.modelId)) {
    return "openai-codex";
  }
  return opts.config.downstreamProvider ?? DEFAULT_DOWNSTREAM_PROVIDER;
}

export type PiRpcProcess = {
  proc: ChildProcess;
  send: PiRpcSendFn;
  sessionId: string;
  requestedModelId?: string;
  requestedProvider?: string;
  requestedWorkspaceDir?: string;
  /** Listeners called for each parsed event/response line */
  listeners: Set<(event: Record<string, unknown>) => void>;
  onClose: Set<() => void>;
  /** True while an OpenClaw turn owns this process (prompt sent, no terminal event yet). */
  turnActive: boolean;
  /** Ring buffer of recent stderr lines for post-mortem on silent failures. */
  stderrTail: string[];
};

type PiRpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

const bindings = new Map<string, PiRpcProcess>();
// Single-flight guard: getOrCreatePiProcess now awaits resolvePiAgentEnv
// (live tool-catalog query, ISSUE-165) before it registers a binding, which
// opened a real race — a concurrent caller for the same session (e.g. a
// poll loop racing the call that triggered the spawn) used to see no binding
// yet and would spawn a second, duplicate pi process. Reserve the session's
// slot with this in-flight promise synchronously, before any await, so every
// concurrent caller converges on the same spawn.
const pendingCreations = new Map<string, Promise<PiRpcProcess>>();

export function buildPiRpcArgv(opts: {
  prefixArgs: string[];
  extraArgs?: string[];
  config: PiHarnessConfig;
  modelId?: string;
  provider?: string;
  workspaceDir?: string;
}): string[] {
  const extraArgs = opts.extraArgs ?? [];
  const modelArgs: string[] = [];
  // `pi-fork` is OpenClaw's synthetic provider marker — pi itself has no such
  // provider in its models.json. Rewrite to a concrete pi-side provider so pi
  // can resolve the model and reach the configured backend. Claude models stay
  // on the claude-bridge sidecar; known ChatGPT/Codex model ids route through
  // openai-codex so `pi-fork/gpt-5.5` keeps the pi harness semantics instead of
  // falling out to the native OpenClaw Codex harness.
  const downstreamProvider = resolvePiRpcProvider({
    config: opts.config,
    provider: opts.provider,
    modelId: opts.modelId,
  });
  if (opts.modelId && opts.provider === "pi-fork") {
    modelArgs.push(
      "--provider",
      downstreamProvider ?? DEFAULT_DOWNSTREAM_PROVIDER,
      "--model",
      opts.modelId,
    );
  } else if (opts.modelId && opts.provider) {
    modelArgs.push("--provider", opts.provider, "--model", opts.modelId);
  } else if (opts.modelId) {
    modelArgs.push("--model", opts.modelId);
  }
  const compactionArgs: string[] = [];
  if (
    typeof opts.config.compactionTriggerTokens === "number" &&
    Number.isFinite(opts.config.compactionTriggerTokens) &&
    opts.config.compactionTriggerTokens > 0
  ) {
    compactionArgs.push(
      "--compaction-trigger-tokens",
      String(Math.floor(opts.config.compactionTriggerTokens)),
    );
  }
  return [
    ...opts.prefixArgs,
    ...extraArgs,
    ...modelArgs,
    ...compactionArgs,
    ...extensionArgsFromEnv(process.env.PI_HARNESS_EXTENSIONS),
    "--mode",
    "rpc",
  ];
}

function extensionArgsFromEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  return raw
    .split(/[,:]/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => ["-e", entry]);
}

export function dispatchPiRpcJsonlChunk(
  state: { buffer: string; parseErrors?: number },
  chunk: string,
  listeners: Set<(event: Record<string, unknown>) => void>,
  context?: { sessionId?: string },
): void {
  state.buffer += chunk;
  while (true) {
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }
    const line = state.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
    state.buffer = state.buffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      state.parseErrors = (state.parseErrors ?? 0) + 1;
      if (state.parseErrors <= PARSE_ERROR_LOG_LIMIT) {
        embeddedAgentLog.warn("pi-fork rpc stdout line is not valid JSONL", {
          sessionId: context?.sessionId,
          parseErrors: state.parseErrors,
          linePreview: line.slice(0, 200),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    for (const listener of listeners) {
      try {
        listener(parsed);
      } catch (err) {
        embeddedAgentLog.warn("pi-fork rpc event listener threw", {
          sessionId: context?.sessionId,
          eventType: typeof parsed.type === "string" ? parsed.type : undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function bindPiRpcJsonlStdout(
  stdout: NodeJS.ReadableStream,
  listeners: Set<(event: Record<string, unknown>) => void>,
  context: { sessionId: string },
): void {
  const state = { buffer: "" };
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk) => {
    dispatchPiRpcJsonlChunk(state, String(chunk), listeners, context);
  });
}

function bindPiStderrTail(stderr: NodeJS.ReadableStream, tail: string[]): void {
  const state = { buffer: "" };
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk) => {
    state.buffer += String(chunk);
    while (true) {
      const newlineIndex = state.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = state.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      state.buffer = state.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      tail.push(line.slice(0, STDERR_TAIL_MAX_LINE_CHARS));
      if (tail.length > STDERR_TAIL_MAX_LINES) {
        tail.shift();
      }
    }
  });
}

export function formatPiStderrTail(piProcess: Pick<PiRpcProcess, "stderrTail">): string {
  return piProcess.stderrTail.length > 0
    ? `; recent pi stderr:\n${piProcess.stderrTail.slice(-10).join("\n")}`
    : "";
}

/**
 * Obtain or create the pi RPC process for a given OpenClaw session.
 * Spawns `pi --mode rpc [--model <id>]` in the requested workspace cwd and keeps it alive.
 */
export async function getOrCreatePiProcess(
  openclaSessionId: string,
  opts: {
    config: PiHarnessConfig;
    modelId?: string;
    provider?: string;
    workspaceDir?: string;
  },
): Promise<PiRpcProcess> {
  const existing = bindings.get(openclaSessionId);
  const requestedWorkspaceDir = opts.workspaceDir ?? process.cwd();
  const requestedProvider = resolvePiRpcProvider({
    config: opts.config,
    provider: opts.provider,
    modelId: opts.modelId,
  });
  if (existing && existing.proc.exitCode === null && !existing.proc.killed) {
    if (
      existing.requestedModelId === opts.modelId &&
      existing.requestedProvider === requestedProvider &&
      existing.requestedWorkspaceDir === requestedWorkspaceDir
    ) {
      return existing;
    }
    clearPiProcess(openclaSessionId);
  }

  const pendingCreation = pendingCreations.get(openclaSessionId);
  if (pendingCreation) {
    const resolved = await pendingCreation;
    if (
      resolved.requestedModelId === opts.modelId &&
      resolved.requestedProvider === requestedProvider &&
      resolved.requestedWorkspaceDir === requestedWorkspaceDir
    ) {
      return resolved;
    }
    // A genuinely different request (model/provider/workspace) raced the
    // pending one — re-evaluate now that it has settled and the pending-map
    // entry below has been cleared.
    return getOrCreatePiProcess(openclaSessionId, opts);
  }

  const creation = (async (): Promise<PiRpcProcess> => {
    // Build argv
    const { bin, prefixArgs } = resolvePiCommand(opts.config);
    const argv = buildPiRpcArgv({
      prefixArgs,
      extraArgs: opts.config.args,
      config: opts.config,
      modelId: opts.modelId,
      provider: opts.provider,
      workspaceDir: opts.workspaceDir,
    });

    const proc = spawn(bin, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: await resolvePiAgentEnv(opts.config, requestedWorkspaceDir),
      cwd: requestedWorkspaceDir,
    });

    const listeners: Set<(event: Record<string, unknown>) => void> = new Set();
    const onClose: Set<() => void> = new Set();
    let closed = false;

    const notifyClose = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (bindings.get(openclaSessionId) === binding) {
        bindings.delete(openclaSessionId);
      }
      for (const handler of onClose) {
        try {
          handler();
        } catch {}
      }
    };

    const send: PiRpcSendFn = (obj) => {
      if (!proc.stdin || proc.stdin.destroyed) {
        embeddedAgentLog.warn("pi-fork rpc send skipped: stdin unavailable", {
          sessionId: openclaSessionId,
          commandType: (obj as { type?: unknown })?.type,
        });
        return;
      }
      try {
        proc.stdin.write(JSON.stringify(obj) + "\n");
      } catch (err) {
        // EPIPE and friends: pi died between the destroyed check and the write.
        embeddedAgentLog.warn("pi-fork rpc send failed", {
          sessionId: openclaSessionId,
          commandType: (obj as { type?: unknown })?.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const stderrTail: string[] = [];
    if (proc.stdout) {
      bindPiRpcJsonlStdout(proc.stdout, listeners, { sessionId: openclaSessionId });
      proc.stdout.on("close", notifyClose);
    }

    proc.on("error", () => {
      notifyClose();
    });

    if (proc.stderr) {
      bindPiStderrTail(proc.stderr, stderrTail);
    }
    // Swallow async stdin errors (EPIPE after pi exit) so they cannot become
    // uncaught stream exceptions in the gateway process.
    proc.stdin?.on("error", (err) => {
      embeddedAgentLog.warn("pi-fork rpc stdin stream error", {
        sessionId: openclaSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Read the pi session ID once it starts (pi emits state on startup via get_state)
    // We'll query it after spawn
    const binding: PiRpcProcess = {
      proc,
      send,
      sessionId: openclaSessionId,
      requestedModelId: opts.modelId,
      requestedProvider,
      requestedWorkspaceDir,
      listeners,
      onClose,
      turnActive: false,
      stderrTail,
    };

    bindings.set(openclaSessionId, binding);
    return binding;
  })();

  pendingCreations.set(openclaSessionId, creation);
  try {
    return await creation;
  } finally {
    pendingCreations.delete(openclaSessionId);
  }
}

/**
 * Kill and remove the pi process for a session.
 */
export function clearPiProcess(openclaSessionId: string): void {
  const binding = bindings.get(openclaSessionId);
  if (!binding) {
    return;
  }
  bindings.delete(openclaSessionId);
  try {
    binding.proc.stdin?.end();
  } catch {}
  try {
    binding.proc.kill("SIGTERM");
  } catch {}
  // A pi process wedged in a tool call can ignore SIGTERM; escalate so a dead
  // session can never leak a live child that keeps streaming into old listeners.
  const escalation = setTimeout(() => {
    if (binding.proc.exitCode === null && binding.proc.signalCode === null) {
      try {
        binding.proc.kill("SIGKILL");
      } catch {}
    }
  }, KILL_ESCALATION_MS);
  escalation.unref?.();
}

/**
 * Kill all pi processes (used on plugin dispose).
 */
export function clearAllPiProcesses(): void {
  for (const [id] of bindings) {
    clearPiProcess(id);
  }
}

export async function sendPiRpcCommand(params: {
  piProcess: PiRpcProcess;
  command: Record<string, unknown> & { type: string; id?: string };
  timeoutMs?: number;
}): Promise<PiRpcResponse> {
  const requestId = params.command.id ?? crypto.randomUUID();

  return new Promise<PiRpcResponse>((resolve, reject) => {
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      params.piProcess.listeners.delete(onEvent);
      params.piProcess.onClose.delete(onClose);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Pi process exited before RPC response"));
    };

    const onEvent = (event: Record<string, unknown>) => {
      if (event.type !== "response") {
        return;
      }
      const response = event as PiRpcResponse;
      if (response.id !== requestId || response.command !== params.command.type) {
        return;
      }
      cleanup();
      if (!response.success) {
        reject(new Error(response.error ?? `Pi RPC ${params.command.type} failed`));
        return;
      }
      resolve(response);
    };

    params.piProcess.listeners.add(onEvent);
    params.piProcess.onClose.add(onClose);

    const timeoutMs = params.timeoutMs ?? 10_000;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Pi RPC ${params.command.type} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    params.piProcess.send({ ...params.command, id: requestId });
  });
}
