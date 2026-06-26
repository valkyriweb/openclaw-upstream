/**
 * Trajectory recording for the Pi Fork runtime.
 *
 * pi-fork runs Kael's turns through a spawned upstream-pi RPC process. Like the
 * canonical transcript (see ./canonical-recorder.ts), the OpenClaw trajectory
 * (`<session>.trajectory.jsonl`) was invisible for pi-fork turns: the embedded
 * and codex runtimes self-record trajectory inside the embedded runner, but the
 * pi-fork harness bypasses that runner and so emitted zero trajectory events —
 * leaving the trajectory pipeline (trace inspection, replay, the lab-parity
 * gate) blind to every Kael turn.
 *
 * This module drives core's own trajectory primitive
 * (`createTrajectoryRuntimeRecorder`) keyed to the canonical session, mapping
 * the pi-fork attempt lifecycle onto the same event vocabulary the embedded
 * runner uses: `session.started`, `prompt.submitted`, `model.completed`,
 * `session.ended`. It is OpenClaw-side only — no pi-mono-fork changes.
 *
 * Best-effort: every record/flush is wrapped so a trajectory failure can never
 * drop, delay, or fail a reply. Idempotent terminal: exactly one
 * `session.ended` is emitted per attempt regardless of how many finish paths
 * (resolve, abort-settle, timeout) reach the terminal call.
 */
import {
  createTrajectoryRuntimeRecorder,
  embeddedAgentLog,
  type TrajectoryRuntimeRecorder,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type PiTrajectoryRecorderInit = {
  /** Canonical session id; the trajectory traceId and file key. */
  sessionId: string;
  /** Canonical transcript path; the trajectory file is derived from it. */
  sessionFile?: string;
  sessionKey?: string;
  runId?: string;
  workspaceDir?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  /** OpenClaw config, forwarded to the core trajectory recorder. */
  config?: OpenClawConfig;
  /** Env override (tests); defaults to process.env inside core. */
  env?: NodeJS.ProcessEnv;
};

export type PiTrajectorySessionStarted = {
  trigger?: string;
  sessionFile?: string;
  workspaceDir?: string;
  agentId?: string;
  provider?: string;
  modelId?: string;
  toolCount?: number;
};

export type PiTrajectoryModelCompleted = {
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  promptError?: string;
  assistantText?: string;
  messagesSnapshot?: unknown[];
};

export type PiTrajectoryTerminal = {
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  promptError?: string;
};

export type PiTrajectoryRecorder = {
  /** Resolved `<session>.trajectory.jsonl` path (for tests + diagnostics). */
  readonly filePath: string;
  recordSessionStarted(data: PiTrajectorySessionStarted): void;
  recordPromptSubmitted(data: { prompt?: string }): void;
  recordModelCompleted(data: PiTrajectoryModelCompleted): void;
  /** Idempotent: only the first call per recorder emits `session.ended`. */
  recordSessionEnded(data: PiTrajectoryTerminal): void;
  flush(): Promise<void>;
};

function deriveStatus(terminal: PiTrajectoryTerminal): string {
  if (terminal.promptError) {
    return "error";
  }
  if (terminal.timedOut) {
    return "timeout";
  }
  if (terminal.aborted || terminal.externalAbort) {
    return "aborted";
  }
  return "ok";
}

/**
 * Create a best-effort trajectory recorder for one pi-fork attempt.
 *
 * Returns `null` when trajectory capture is disabled (`OPENCLAW_TRAJECTORY=0`)
 * or core declines to create a recorder, so callers gate every emission on the
 * recorder being present (`recorder?.record…`).
 */
export function createPiTrajectoryRecorder(
  init: PiTrajectoryRecorderInit,
): PiTrajectoryRecorder | null {
  let runtime: TrajectoryRuntimeRecorder | null;
  try {
    runtime = createTrajectoryRuntimeRecorder({
      cfg: init.config,
      env: init.env,
      runId: init.runId,
      sessionId: init.sessionId,
      sessionKey: init.sessionKey,
      sessionFile: init.sessionFile,
      provider: init.provider,
      modelId: init.modelId,
      modelApi: init.modelApi,
      workspaceDir: init.workspaceDir,
    });
  } catch (err) {
    embeddedAgentLog.warn("pi-fork trajectory recorder init failed", {
      sessionId: init.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!runtime) {
    return null;
  }
  const recorder = runtime;

  let endedRecorded = false;
  const safeRecord = (type: string, data?: Record<string, unknown>): void => {
    try {
      recorder.recordEvent(type, data);
    } catch (err) {
      embeddedAgentLog.warn("pi-fork trajectory event failed", {
        sessionId: init.sessionId,
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    filePath: recorder.filePath,
    recordSessionStarted(data) {
      safeRecord("session.started", { ...data });
    },
    recordPromptSubmitted(data) {
      safeRecord("prompt.submitted", { ...data });
    },
    recordModelCompleted(data) {
      safeRecord("model.completed", {
        aborted: data.aborted,
        externalAbort: data.externalAbort,
        timedOut: data.timedOut,
        promptError: data.promptError,
        assistantTexts: data.assistantText ? [data.assistantText] : [],
        messagesSnapshot: data.messagesSnapshot,
      });
    },
    recordSessionEnded(data) {
      if (endedRecorded) {
        return;
      }
      endedRecorded = true;
      safeRecord("session.ended", {
        status: deriveStatus(data),
        aborted: data.aborted,
        externalAbort: data.externalAbort,
        timedOut: data.timedOut,
        terminalError: data.promptError,
      });
    },
    async flush() {
      try {
        await recorder.flush();
      } catch (err) {
        embeddedAgentLog.warn("pi-fork trajectory flush failed", {
          sessionId: init.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
