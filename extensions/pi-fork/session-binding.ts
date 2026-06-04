/**
 * Pi RPC process binding — one long-lived pi process per OpenClaw session.
 *
 * Keeps a map of OpenClaw sessionId → PiRpcProcess so turns within the same
 * conversation share a single pi session (preserving history, compaction state,
 * and pi's own tool context).
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type { PiHarnessConfig } from "./config.js";
import { resolvePiCommand } from "./config.js";
import { ensurePiHarnessAgentSettings, resolvePiAgentDir } from "./managed-runtime.js";

function resolvePiAgentEnv(config: PiHarnessConfig): NodeJS.ProcessEnv {
  ensurePiHarnessAgentSettings(config);
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: resolvePiAgentDir(config),
  };
}

export type PiRpcSendFn = (obj: unknown) => void;

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
  // can resolve the model and reach the configured backend (default: the
  // claude-bridge sidecar). Without this rewrite pi falls through to its
  // built-in anthropic catalog and dies on `No API key found for anthropic`.
  const downstreamProvider = opts.config.downstreamProvider ?? "claude-bridge";
  if (opts.modelId && opts.provider === "pi-fork") {
    modelArgs.push("--provider", downstreamProvider, "--model", opts.modelId);
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
  state: { buffer: string },
  chunk: string,
  listeners: Set<(event: Record<string, unknown>) => void>,
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
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const listener of listeners) {
        try {
          listener(parsed);
        } catch {}
      }
    } catch {}
  }
}

function bindPiRpcJsonlStdout(
  stdout: NodeJS.ReadableStream,
  listeners: Set<(event: Record<string, unknown>) => void>,
): void {
  const state = { buffer: "" };
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk) => {
    dispatchPiRpcJsonlChunk(state, String(chunk), listeners);
  });
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
  if (existing && existing.proc.exitCode === null && !existing.proc.killed) {
    if (
      existing.requestedModelId === opts.modelId &&
      existing.requestedProvider === opts.provider &&
      existing.requestedWorkspaceDir === requestedWorkspaceDir
    ) {
      return existing;
    }
    clearPiProcess(openclaSessionId);
  }

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
    env: resolvePiAgentEnv(opts.config),
    cwd: requestedWorkspaceDir,
  });

  const listeners: Set<(event: Record<string, unknown>) => void> = new Set();
  const onClose: Set<() => void> = new Set();
  let closed = false;
  let binding: PiRpcProcess;

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
    if (proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.write(JSON.stringify(obj) + "\n");
    }
  };

  if (proc.stdout) {
    bindPiRpcJsonlStdout(proc.stdout, listeners);
    proc.stdout.on("close", notifyClose);
  }

  proc.on("error", () => {
    notifyClose();
  });

  proc.stderr?.resume(); // drain stderr so the process doesn't block

  // Read the pi session ID once it starts (pi emits state on startup via get_state)
  // We'll query it after spawn
  binding = {
    proc,
    send,
    sessionId: openclaSessionId,
    requestedModelId: opts.modelId,
    requestedProvider: opts.provider,
    requestedWorkspaceDir,
    listeners,
    onClose,
  };

  bindings.set(openclaSessionId, binding);
  return binding;
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
    let timeout: ReturnType<typeof setTimeout> | undefined;

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
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Pi RPC ${params.command.type} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    params.piProcess.send({ ...params.command, id: requestId });
  });
}
