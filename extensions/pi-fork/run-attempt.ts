/**
 * Core turn executor for the Pi Fork plugin.
 *
 * Routes one OpenClaw agent turn through the pi RPC runtime:
 *   1. Obtain (or create) the persistent pi process for this OpenClaw session
 *   2. Send `{ type: "prompt", message, images? }` to pi's stdin
 *   3. Collect AgentSessionEvents from pi's stdout until `agent_end` or timeout
 *   4. Construct a complete EmbeddedRunAttemptResult from the collected events
 *
 * Pi owns tool execution, compaction, and session history.
 * OpenClaw owns channel delivery, transcript mirroring, and session selection.
 */
import crypto from "node:crypto";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  resolveAgentHarnessBeforePromptBuildResult as resolveBeforePromptBuild,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { recordPiTurnCanonically } from "./canonical-recorder.js";
import type { PiHarnessConfig } from "./config.js";
import { buildPiRpcPrompt } from "./prompt-contract.js";
import {
  clearPiProcess,
  formatPiStderrTail,
  getOrCreatePiProcess,
  sendPiRpcCommand,
  type PiRpcProcess,
} from "./session-binding.js";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
/** How long an externally-aborted pi turn may keep running before the process is replaced. */
const ABORT_SETTLE_MS = 10_000;
/** Ack timeout for steering messages injected into an active pi turn. */
const STEER_ACK_TIMEOUT_MS = 10_000;
/** Floor between run-progress signals so streaming deltas don't flood diagnostics. */
const PROGRESS_THROTTLE_MS = 1_000;
/** Cap on unknown-event debug logs per turn. */
const UNKNOWN_EVENT_LOG_LIMIT = 5;

function normalizePositiveTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function resolvePiTurnTimeoutMs(
  params: AgentHarnessAttemptParams,
  config: Pick<PiHarnessConfig, "turnTimeoutMs">,
): number {
  const shaped = params as unknown as { runTimeoutOverrideMs?: unknown; timeoutMs?: unknown };
  return (
    normalizePositiveTimeoutMs(shaped.runTimeoutOverrideMs) ??
    normalizePositiveTimeoutMs(shaped.timeoutMs) ??
    normalizePositiveTimeoutMs(config.turnTimeoutMs) ??
    DEFAULT_TURN_TIMEOUT_MS
  );
}

// ---------------------------------------------------------------------------
// Pi event shapes (subset we care about)
// ---------------------------------------------------------------------------

type PiMessageEvent = {
  type: "message_update" | "message_start" | "message_end";
  message: {
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  };
};

type PiAgentEndEvent = {
  type: "agent_end";
  messages?: unknown[];
};

type PiAssistantUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read?: number;
  cache_write?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type NormalizedPiUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type PiToolStartEvent = {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
};

type PiToolEndEvent = {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

type PiRpcResponse = {
  type: "response";
  command: string;
  success: boolean;
  error?: string;
};

type PiPromptCommand = {
  type: "prompt";
  message: string;
  images?: unknown[];
};

// ---------------------------------------------------------------------------
// Text extraction from pi content blocks
// ---------------------------------------------------------------------------

function extractText(content: PiMessageEvent["message"]["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : ((b as { text?: string }).text ?? "")))
      .join("");
  }
  return "";
}

function normalizeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function normalizePiUsage(raw: PiAssistantUsage | undefined): NormalizedPiUsage | undefined {
  if (!raw) {
    return undefined;
  }
  const cacheRead = normalizeTokenCount(
    raw.cacheRead ??
      raw.cache_read ??
      raw.cache_read_input_tokens ??
      raw.cached_tokens ??
      raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens,
  );
  const input = normalizeTokenCount(
    raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens,
  );
  const output = normalizeTokenCount(
    raw.output ??
      raw.outputTokens ??
      raw.output_tokens ??
      raw.completionTokens ??
      raw.completion_tokens,
  );
  const cacheWrite = normalizeTokenCount(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );
  const total = normalizeTokenCount(raw.total ?? raw.totalTokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function findLastAssistantUsage(messages: unknown[]): NormalizedPiUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; usage?: PiAssistantUsage };
    if (message?.role === "assistant") {
      const usage = normalizePiUsage(message.usage);
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Baseline EmbeddedRunAttemptResult builder
// ---------------------------------------------------------------------------

/**
 * Build the full EmbeddedRunAttemptResult from pi RPC turn data.
 *
 * Fields that pi populates:
 *   - assistantTexts, toolMetas, messagesSnapshot, replayMetadata, itemLifecycle
 *
 * Fields that are pi-fork–specific defaults (safe for turn routing):
 *   - aborted, externalAbort, timedOut, idleTimedOut, timedOutDuringCompaction
 *   - promptError, promptErrorSource
 *   - didSendViaMessagingTool, messagingTool*, cloudCodeAssistFormatError
 *   - lastAssistant (constructed from final text)
 */
export function buildAttemptResult(opts: {
  assistantText: string;
  toolMetas: Array<{ toolName: string; meta?: string }>;
  activeToolCount?: number;
  messagesSnapshot: unknown[];
  sessionIdUsed: string;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  promptError: unknown;
}): AgentHarnessAttemptResult {
  const normalizedActiveToolCount = opts.activeToolCount ?? 0;
  const activeToolCount =
    Number.isFinite(normalizedActiveToolCount) && normalizedActiveToolCount > 0
      ? Math.trunc(normalizedActiveToolCount)
      : 0;
  const startedToolCount = opts.toolMetas.length + activeToolCount;
  const hadTools = startedToolCount > 0;
  const assistantUsage = findLastAssistantUsage(opts.messagesSnapshot);

  const lastAssistant = opts.assistantText
    ? ({
        role: "assistant",
        content: [{ type: "text", text: opts.assistantText }],
        stopReason: "end_turn",
        ...(assistantUsage ? { usage: assistantUsage } : {}),
      } as unknown as AgentHarnessAttemptResult["lastAssistant"])
    : undefined;

  return {
    // Lifecycle flags
    aborted: opts.aborted,
    externalAbort: opts.externalAbort,
    timedOut: opts.timedOut,
    idleTimedOut: false,
    timedOutDuringCompaction: false,

    // Error state
    promptError: opts.promptError,
    promptErrorSource: opts.promptError ? "prompt" : null,

    // Session identity
    sessionIdUsed: opts.sessionIdUsed,

    // Content
    messagesSnapshot: opts.messagesSnapshot as AgentHarnessAttemptResult["messagesSnapshot"],
    assistantTexts: opts.assistantText ? [opts.assistantText] : [],
    toolMetas: opts.toolMetas,
    ...(assistantUsage ? { attemptUsage: assistantUsage } : {}),
    lastAssistant,
    currentAttemptAssistant: lastAssistant,

    // Messaging tools — pi does not use OpenClaw messaging tools
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],

    // Misc
    cloudCodeAssistFormatError: false,

    // Replay safety: turns with tool calls are not safe to replay
    replayMetadata: {
      hadPotentialSideEffects: hadTools,
      replaySafe: !hadTools,
    },

    // Item lifecycle (tracks tool invocations at a count level)
    itemLifecycle: {
      startedCount: startedToolCount,
      completedCount: opts.toolMetas.length,
      activeCount: activeToolCount,
    },
  } as unknown as AgentHarnessAttemptResult;
}

// ---------------------------------------------------------------------------
// Main runAttempt implementation
// ---------------------------------------------------------------------------

export function buildPiPromptCommand(
  params: AgentHarnessAttemptParams,
  config: PiHarnessConfig,
): PiPromptCommand {
  const images = (params as unknown as { images?: unknown[] }).images;
  return {
    type: "prompt",
    message: buildPiRpcPrompt(params, config),
    ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
  };
}

type PromptBuildAttemptParams = AgentHarnessAttemptParams & {
  prompt?: string;
  extraSystemPrompt?: string;
};

async function buildHookedPiPromptCommand(
  params: AgentHarnessAttemptParams,
  config: PiHarnessConfig,
): Promise<PiPromptCommand> {
  const shaped = params as PromptBuildAttemptParams;
  const promptBuild = await resolveBeforePromptBuild({
    prompt: shaped.prompt ?? "",
    developerInstructions: shaped.extraSystemPrompt ?? "",
    messages: [],
    // Upstream tightened AgentHarnessHookContext.senderId to string|undefined;
    // attempt params still allow null, so coerce it for the hook context.
    ctx: { ...params, senderId: params.senderId ?? undefined },
  });

  return buildPiPromptCommand(
    {
      ...params,
      prompt: promptBuild.prompt,
      extraSystemPrompt: promptBuild.developerInstructions,
    } as AgentHarnessAttemptParams,
    config,
  );
}

type RunProgressInfo = {
  reason: string;
  provider?: string;
  model?: string;
  backend?: string;
};

type ShapedAttemptParams = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  runId?: string;
  modelId?: string;
  provider?: string;
  workspaceDir?: string;
  abortSignal?: AbortSignal;
  onRunProgress?: (info: RunProgressInfo) => void;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
};

export async function runPiRpcAttempt(
  params: AgentHarnessAttemptParams,
  config: PiHarnessConfig,
): Promise<AgentHarnessAttemptResult> {
  const turnTimeoutMs = resolvePiTurnTimeoutMs(params, config);
  const shaped = params as unknown as ShapedAttemptParams;
  const sessionId = shaped.sessionId ?? shaped.sessionKey ?? crypto.randomUUID();
  const sessionKey = shaped.sessionKey;
  const spawnOpts = {
    config,
    modelId: shaped.modelId,
    provider: shaped.provider,
    workspaceDir: shaped.workspaceDir,
  };

  let piProcess: PiRpcProcess;
  try {
    piProcess = await getOrCreatePiProcess(sessionId, spawnOpts);
    if (piProcess.turnActive) {
      // The session lane serializes legitimate turns, so an already-active
      // marker here means a zombie turn still owns this binding (e.g. an abort
      // pi never honored). Replace the process rather than share its stream.
      embeddedAgentLog.warn("pi-fork binding still turn-active at attempt start; respawning", {
        sessionId,
        sessionKey,
      });
      clearPiProcess(sessionId);
      piProcess = await getOrCreatePiProcess(sessionId, spawnOpts);
    }
  } catch (err) {
    return buildAttemptResult({
      assistantText: "",
      toolMetas: [],
      messagesSnapshot: [],
      sessionIdUsed: sessionId,
      aborted: false,
      externalAbort: false,
      timedOut: false,
      promptError: err,
    });
  }

  const promptCommand = await buildHookedPiPromptCommand(params, config);

  return new Promise<AgentHarnessAttemptResult>((resolve) => {
    let assistantText = "";
    let finalMessagesSnapshot: unknown[] = [];
    const toolMetas: Array<{ toolName: string; meta?: string }> = [];
    const toolCallIds = new Map<string, string>(); // toolCallId → toolName

    let promptErrored = false;
    let promptErrorMsg = "";
    let done = false;
    let healed = false;
    let unknownEventCount = 0;
    let lastProgressAt = 0;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let closeHandler: (() => void) | undefined;

    // Feed both liveness clocks while pi works: the command-lane task timeout
    // (params.onRunProgress -> noteLaneTaskProgress) and the stuck-session
    // detector (run.progress diagnostic events -> diagnostic-run-activity).
    // Without these, any turn longer than diagnostics.stuckSessionAbortMs with
    // queued messages behind it is classified stalled and watchdog-aborted.
    const touchProgress = (reason: string, opts?: { force?: boolean }) => {
      const now = Date.now();
      if (!opts?.force && now - lastProgressAt < PROGRESS_THROTTLE_MS) {
        return;
      }
      lastProgressAt = now;
      try {
        shaped.onRunProgress?.({
          reason,
          provider: shaped.provider,
          model: shaped.modelId,
          backend: "pi-fork-rpc",
        });
      } catch {}
      try {
        emitTrustedDiagnosticEvent({
          type: "run.progress",
          runId: shaped.runId,
          sessionId,
          sessionKey,
          reason: `pi_fork:${reason}`,
        });
      } catch {}
    };

    const attachTurn = () => {
      piProcess.listeners.add(onEvent);
      if (closeHandler) {
        piProcess.onClose.add(closeHandler);
      }
    };
    const detachTurn = () => {
      piProcess.listeners.delete(onEvent);
      if (closeHandler) {
        piProcess.onClose.delete(closeHandler);
      }
    };

    const finish = (opts: {
      aborted?: boolean;
      externalAbort?: boolean;
      timedOut?: boolean;
      promptError?: unknown;
      /** If true, query pi for authoritative final text before resolving. */
      queryFinalText?: boolean;
      /** Keep turnActive set; an abort-settle watcher owns the binding state. */
      deferTurnRelease?: boolean;
    }) => {
      if (done) {
        return;
      }
      done = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      detachTurn();
      closeHandler = undefined;
      clearActiveEmbeddedRun(sessionId, queueHandle, sessionKey, shaped.sessionFile);
      if (!opts.deferTurnRelease) {
        piProcess.turnActive = false;
      }

      const resolveResult = (finalText: string, finalMessages: unknown[]) => {
        // Mirror pi's authoritative snapshot into the canonical OpenClaw
        // transcript before resolving. The await ordering is load-bearing: the
        // next (session-lane-serialized) turn reads the canonical message count
        // as its append cursor, so a fire-and-forget mirror would let it observe
        // a stale count and double-append. Best-effort — a mirror failure must
        // never drop or delay-fail the reply, only this turn's canonical record.
        void (async () => {
          try {
            await recordPiTurnCanonically(
              {
                sessionFile: shaped.sessionFile,
                sessionId,
                cwd: shaped.workspaceDir,
                config: (params as { config?: OpenClawConfig }).config,
              },
              finalMessages,
            );
          } catch (err) {
            embeddedAgentLog.warn("pi-fork canonical transcript mirror failed", {
              sessionId,
              sessionKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          resolve(
            buildAttemptResult({
              assistantText: finalText,
              toolMetas,
              activeToolCount: toolCallIds.size,
              messagesSnapshot: finalMessages,
              sessionIdUsed: sessionId,
              aborted: opts.aborted ?? false,
              externalAbort: opts.externalAbort ?? false,
              timedOut: opts.timedOut ?? false,
              promptError: opts.promptError ?? (promptErrored ? new Error(promptErrorMsg) : null),
            }),
          );
        })();
      };

      // Query authoritative text from pi after agent_end, if not aborted/errored
      if (
        opts.queryFinalText &&
        !opts.aborted &&
        !opts.timedOut &&
        !opts.promptError &&
        !promptErrored
      ) {
        const textReqId = crypto.randomUUID();
        const msgReqId = crypto.randomUUID();
        let gotText = false;
        let gotMessages = false;
        let resolvedText = assistantText;
        let resolvedMessages = finalMessagesSnapshot;

        const tryResolve = () => {
          if (gotText && gotMessages) {
            piProcess.listeners.delete(queryListener);
            resolveResult(resolvedText, resolvedMessages);
          }
        };

        const queryListener = (ev: Record<string, unknown>) => {
          if (ev.type !== "response") {
            return;
          }
          const r = ev as {
            id?: string;
            type: string;
            command: string;
            success: boolean;
            data?: Record<string, unknown>;
          };
          if (r.id === textReqId && r.command === "get_last_assistant_text") {
            if (r.success && r.data) {
              const text = r.data.text;
              if (typeof text === "string" && text) {
                resolvedText = text;
              }
            }
            gotText = true;
            tryResolve();
          }
          if (r.id === msgReqId && r.command === "get_messages") {
            if (r.success && r.data) {
              const msgs = r.data.messages;
              if (Array.isArray(msgs)) {
                resolvedMessages = msgs;
              }
            }
            gotMessages = true;
            tryResolve();
          }
        };
        piProcess.listeners.add(queryListener);
        piProcess.send({ id: textReqId, type: "get_last_assistant_text" });
        piProcess.send({ id: msgReqId, type: "get_messages" });

        // Fallback: if pi doesn't respond in 5s, resolve with what we have
        setTimeout(() => {
          if (gotText && gotMessages) {
            return;
          }
          piProcess.listeners.delete(queryListener);
          resolveResult(resolvedText, resolvedMessages);
        }, 5_000);
      } else {
        resolveResult(assistantText, finalMessagesSnapshot);
      }
    };

    // Heal a binding whose pi rejected our prompt because a previous turn is
    // still running inside it (zombie after an unhonored abort). The session
    // lane guarantees no legitimate concurrent turn, so replacing the process
    // and resending once is deterministic recovery instead of a dropped reply.
    const healBusyBindingAndResend = async () => {
      touchProgress("busy_heal_respawn", { force: true });
      embeddedAgentLog.warn("pi-fork prompt rejected: pi busy with zombie turn; respawning", {
        sessionId,
        sessionKey,
      });
      detachTurn();
      clearPiProcess(sessionId);
      try {
        piProcess = await getOrCreatePiProcess(sessionId, spawnOpts);
      } catch (err) {
        finish({ promptError: err });
        return;
      }
      if (done) {
        piProcess.turnActive = false;
        return;
      }
      attachTurn();
      piProcess.turnActive = true;
      piProcess.send(promptCommand);
    };

    const onEvent = (event: Record<string, unknown>) => {
      if (done) {
        return;
      }

      const type = event.type as string | undefined;

      if (type === "message_update" || type === "message_start" || type === "message_end") {
        const e = event as unknown as PiMessageEvent;
        touchProgress("assistant_stream");
        if (e.message?.role === "assistant") {
          if (e.message.stopReason === "error") {
            promptErrored = true;
            promptErrorMsg = e.message.errorMessage ?? "pi RPC assistant turn failed";
            finish({ promptError: new Error(promptErrorMsg) });
            return;
          }
          const partial = extractText(e.message.content);
          if (partial) {
            assistantText = partial;
          }
        }
        return;
      }

      if (type === "tool_execution_start") {
        const e = event as unknown as PiToolStartEvent;
        toolCallIds.set(e.toolCallId, e.toolName);
        touchProgress(`tool_start:${e.toolName}`, { force: true });
        return;
      }

      if (type === "tool_execution_end") {
        const e = event as unknown as PiToolEndEvent;
        const toolName = e.toolName || toolCallIds.get(e.toolCallId) || "unknown";
        toolMetas.push({ toolName, meta: e.isError ? "error" : undefined });
        toolCallIds.delete(e.toolCallId);
        touchProgress(`tool_end:${toolName}`, { force: true });
        return;
      }

      if (
        type === "agent_start" ||
        type === "turn_start" ||
        type === "turn_end" ||
        type === "tool_execution_update"
      ) {
        touchProgress(type);
        return;
      }

      if (type === "agent_end") {
        const e = event as unknown as PiAgentEndEvent;
        // Use messages from the event as initial snapshot.
        // We'll query get_last_assistant_text + get_messages after resolving.
        finalMessagesSnapshot = e.messages ?? [];
        finish({ queryFinalText: true });
        return;
      }

      if (type === "response") {
        const e = event as unknown as PiRpcResponse;
        if (e.command === "prompt") {
          if (e.success) {
            touchProgress("prompt_accepted", { force: true });
            return;
          }
          if (!healed && /already processing/iu.test(e.error ?? "")) {
            healed = true;
            void healBusyBindingAndResend();
            return;
          }
          promptErrored = true;
          promptErrorMsg = e.error ?? "pi RPC prompt failed";
          finish({ promptError: new Error(promptErrorMsg) });
        }
        return;
      }

      unknownEventCount += 1;
      if (unknownEventCount <= UNKNOWN_EVENT_LOG_LIMIT) {
        embeddedAgentLog.debug("pi-fork rpc event ignored (no handler)", {
          sessionId,
          eventType: type,
          unknownEventCount,
        });
      }
    };

    // Mid-turn steering parity: register a queue handle so OpenClaw's default
    // messages.queue.mode="steer" injects burst messages (e.g. several forwarded
    // WhatsApp messages) into the active pi turn instead of stalling behind it.
    const queueHandle = {
      kind: "embedded" as const,
      queueMessage: async (text: string) => {
        if (done) {
          throw new Error("pi-fork turn already finished");
        }
        await sendPiRpcCommand({
          piProcess,
          command: { type: "steer", message: text },
          timeoutMs: STEER_ACK_TIMEOUT_MS,
        });
        if (done) {
          // The turn ended while the steer was in flight; pi may never run it.
          // Throwing routes the message back to the followup queue.
          throw new Error("pi-fork turn finished before steer delivery");
        }
        touchProgress("steer_queued", { force: true });
      },
      isStreaming: () => !done,
      isCompacting: () => false,
      sourceReplyDeliveryMode: shaped.sourceReplyDeliveryMode,
      cancel: () => {
        onAbort();
      },
      abort: () => {
        onAbort();
      },
    };

    // After an external abort we let OpenClaw move on immediately, but pi may
    // still be mid tool-call. Watch for it to settle; replace the process if it
    // does not, so the next turn never inherits a wedged binding.
    const installAbortSettleWatch = () => {
      const ownedProcess = piProcess;
      const settleListener = (event: Record<string, unknown>) => {
        const type = event.type as string | undefined;
        const isAbortAck =
          type === "response" && (event as { command?: string }).command === "abort";
        if (type === "agent_end" || isAbortAck) {
          ownedProcess.listeners.delete(settleListener);
          clearTimeout(settleTimer);
          ownedProcess.turnActive = false;
        }
      };
      ownedProcess.listeners.add(settleListener);
      const settleTimer = setTimeout(() => {
        ownedProcess.listeners.delete(settleListener);
        if (ownedProcess.turnActive) {
          embeddedAgentLog.warn("pi-fork abort settle timed out; replacing pi process", {
            sessionId,
            sessionKey,
          });
          clearPiProcess(sessionId);
          ownedProcess.turnActive = false;
        }
      }, ABORT_SETTLE_MS);
      settleTimer.unref?.();
    };

    const onAbort = () => {
      if (done) {
        return;
      }
      try {
        piProcess.send({ type: "abort" });
      } catch {}
      installAbortSettleWatch();
      finish({ aborted: true, externalAbort: true, deferTurnRelease: true });
    };

    // Handle pi process dying mid-turn
    closeHandler = () => {
      if (!done) {
        finish({
          promptError: new Error(
            `Pi process exited unexpectedly during turn${formatPiStderrTail(piProcess)}`,
          ),
        });
      }
    };

    attachTurn();
    setActiveEmbeddedRun(sessionId, queueHandle, sessionKey, shaped.sessionFile);
    piProcess.turnActive = true;

    // Handle external abort signal
    const abortSignal = shaped.abortSignal;
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    // Turn timeout
    timeoutHandle = setTimeout(() => {
      if (!done) {
        try {
          piProcess.send({ type: "abort" });
        } catch {}
        clearPiProcess(sessionId);
        piProcess.turnActive = false;
        finish({ timedOut: true });
      }
    }, turnTimeoutMs);

    // Send the prompt
    touchProgress("prompt_sent", { force: true });
    piProcess.send(promptCommand);
  });
}
