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
import { resolveAgentHarnessBeforePromptBuildResult as resolveBeforePromptBuild } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PiHarnessConfig } from "./config.js";
import { buildPiRpcPrompt } from "./prompt-contract.js";
import { clearPiProcess, getOrCreatePiProcess, type PiRpcProcess } from "./session-binding.js";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

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
    developerInstructions: shaped.extraSystemPrompt,
    messages: [],
    ctx: params,
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

export async function runPiRpcAttempt(
  params: AgentHarnessAttemptParams,
  config: PiHarnessConfig,
): Promise<AgentHarnessAttemptResult> {
  const turnTimeoutMs = resolvePiTurnTimeoutMs(params, config);
  const sessionId =
    (params as unknown as { sessionId?: string }).sessionId ??
    (params as unknown as { sessionKey?: string }).sessionKey ??
    crypto.randomUUID();

  let piProcess: PiRpcProcess;
  try {
    piProcess = await getOrCreatePiProcess(sessionId, {
      config,
      modelId: (params as unknown as { modelId?: string }).modelId,
      provider: (params as unknown as { provider?: string }).provider,
      workspaceDir: (params as unknown as { workspaceDir?: string }).workspaceDir,
    });
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
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let closeHandler: (() => void) | undefined;

    const finish = (opts: {
      aborted?: boolean;
      externalAbort?: boolean;
      timedOut?: boolean;
      promptError?: unknown;
      /** If true, query pi for authoritative final text before resolving. */
      queryFinalText?: boolean;
    }) => {
      if (done) {
        return;
      }
      done = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      piProcess.listeners.delete(onEvent);
      if (closeHandler) {
        piProcess.onClose.delete(closeHandler);
        closeHandler = undefined;
      }

      const resolveResult = (finalText: string, finalMessages: unknown[]) => {
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

    const onEvent = (event: Record<string, unknown>) => {
      if (done) {
        return;
      }

      const type = event.type as string | undefined;

      if (type === "message_update" || type === "message_start" || type === "message_end") {
        const e = event as unknown as PiMessageEvent;
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
            // Stream partial text to OpenClaw (if the harness params expose a streaming hook)
            const onPartial = (params as unknown as { onPartialText?: (text: string) => void })
              .onPartialText;
            onPartial?.(partial);
          }
        }
        return;
      }

      if (type === "tool_execution_start") {
        const e = event as unknown as PiToolStartEvent;
        toolCallIds.set(e.toolCallId, e.toolName);
        return;
      }

      if (type === "tool_execution_end") {
        const e = event as unknown as PiToolEndEvent;
        const toolName = e.toolName || toolCallIds.get(e.toolCallId) || "unknown";
        toolMetas.push({ toolName, meta: e.isError ? "error" : undefined });
        toolCallIds.delete(e.toolCallId);
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
        if (e.command === "prompt" && !e.success) {
          promptErrored = true;
          promptErrorMsg = e.error ?? "pi RPC prompt failed";
          finish({ promptError: new Error(promptErrorMsg) });
        }
        return;
      }
    };

    piProcess.listeners.add(onEvent);

    // Handle external abort signal
    const abortSignal = (params as unknown as { abortSignal?: AbortSignal }).abortSignal;
    if (abortSignal?.aborted) {
      finish({ aborted: true, externalAbort: true });
      return;
    }
    const onAbort = () => {
      if (done) {
        return;
      }
      try {
        piProcess.send({ type: "abort" });
      } catch {}
      finish({ aborted: true, externalAbort: true });
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    // Handle pi process dying mid-turn
    closeHandler = () => {
      if (!done) {
        finish({ promptError: new Error("Pi process exited unexpectedly during turn") });
      }
    };
    piProcess.onClose.add(closeHandler);

    // Turn timeout
    timeoutHandle = setTimeout(() => {
      if (!done) {
        try {
          piProcess.send({ type: "abort" });
        } catch {}
        clearPiProcess(sessionId);
        finish({ timedOut: true });
      }
    }, turnTimeoutMs);

    // Send the prompt
    piProcess.send(promptCommand);
  });
}
