import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PiHarnessConfig } from "./config.js";

type PiHarnessTrigger = "heartbeat" | "cron" | "manual" | "memory" | "overflow" | "user";

type PromptContextReply = {
  body?: string;
  senderLabel?: string;
  isQuote?: boolean;
};

type PromptContextReplyChainItem = {
  messageId?: string;
  threadId?: string;
  sender?: string;
  senderId?: string;
  senderUsername?: string;
  timestamp?: number;
  body?: string;
  isQuote?: boolean;
  mediaType?: string;
  mediaPath?: string;
  mediaRef?: string;
  replyToId?: string;
  forwardedFrom?: string;
  forwardedFromId?: string;
  forwardedFromUsername?: string;
  forwardedDate?: number;
};

type CurrentTurnPromptContext = {
  reply?: PromptContextReply;
  replyChain?: PromptContextReplyChainItem[];
};

type CurrentInboundPromptContext = {
  text?: string;
  promptJoiner?: string;
};

type PromptParamsShape = AgentHarnessAttemptParams & {
  trigger?: PiHarnessTrigger;
  prompt?: string;
  transcriptPrompt?: string;
  currentTurnContext?: CurrentTurnPromptContext;
  currentInboundContext?: CurrentInboundPromptContext;
  extraSystemPrompt?: string;
};

const DEFAULT_LEAN_PROMPT_TRIGGERS = new Set<PiHarnessTrigger>(["heartbeat", "cron"]);

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatReply(reply: PromptContextReply | undefined): string[] {
  if (!reply) {
    return [];
  }
  const body = normalizeText(reply.body);
  const senderLabel = normalizeText(reply.senderLabel);
  const lines = ["reply:"];
  if (senderLabel) {
    lines.push(`  sender: ${senderLabel}`);
  }
  if (reply.isQuote === true) {
    lines.push("  quote: true");
  }
  if (body) {
    lines.push("  body: |", ...body.split("\n").map((line) => `    ${line}`));
  }
  return lines.length > 1 ? lines : [];
}

function formatReplyChainItem(item: PromptContextReplyChainItem, index: number): string[] {
  const lines = [`  - index: ${index}`];
  const orderedFields: Array<[string, string | number | boolean | undefined]> = [
    ["messageId", item.messageId],
    ["threadId", item.threadId],
    ["sender", item.sender],
    ["senderId", item.senderId],
    ["senderUsername", item.senderUsername],
    ["timestamp", item.timestamp],
    ["replyToId", item.replyToId],
    ["forwardedFrom", item.forwardedFrom],
    ["forwardedFromId", item.forwardedFromId],
    ["forwardedFromUsername", item.forwardedFromUsername],
    ["forwardedDate", item.forwardedDate],
    ["mediaType", item.mediaType],
    ["mediaPath", item.mediaPath],
    ["mediaRef", item.mediaRef],
  ];
  for (const [key, value] of orderedFields) {
    if (value !== undefined && `${value}`.trim()) {
      lines.push(`    ${key}: ${value}`);
    }
  }
  if (item.isQuote === true) {
    lines.push("    quote: true");
  }
  const body = normalizeText(item.body);
  if (body) {
    lines.push("    body: |", ...body.split("\n").map((line) => `      ${line}`));
  }
  return lines;
}

function formatCurrentTurnContext(context: CurrentTurnPromptContext | undefined): string[] {
  if (!context) {
    return [];
  }
  const sections: string[] = ["Current turn context:"];
  const replyLines = formatReply(context.reply);
  if (replyLines.length > 0) {
    sections.push(...replyLines);
  }
  if (Array.isArray(context.replyChain) && context.replyChain.length > 0) {
    sections.push("replyChain:");
    context.replyChain.forEach((item, index) => {
      sections.push(...formatReplyChainItem(item, index));
    });
  }
  return sections.length > 1 ? sections : [];
}

function prependExtraSystemPrompt(prompt: string, extraSystemPrompt: string | undefined): string {
  const extra = normalizeText(extraSystemPrompt);
  if (!extra) {
    return prompt;
  }
  return [`Additional system instructions:`, extra, "", prompt].join("\n");
}

function prependCurrentInboundContext(
  prompt: string,
  context: CurrentInboundPromptContext | undefined,
): string {
  const text = normalizeText(context?.text);
  if (!text) {
    return prompt;
  }
  if (!prompt) {
    return text;
  }
  return [text, prompt].join(context?.promptJoiner ?? "\n\n");
}

function buildLowDepthContract(trigger: PiHarnessTrigger): string[] {
  const base = [
    `Lane: ${trigger}`,
    "Contract:",
    "- This is a low-depth automation turn routed through pi-fork.",
    "- Use only the current turn plus on-demand workspace reads; do not assume prior OpenClaw transcript context.",
    "- Keep the reply minimal and task-focused.",
  ];

  if (trigger === "heartbeat") {
    base.push("- If nothing needs attention, reply exactly HEARTBEAT_OK.");
  }

  if (trigger === "cron") {
    base.push("- Complete the requested maintenance task and avoid generic status chatter.");
  }

  return base;
}

export function buildPiRpcPrompt(
  params: AgentHarnessAttemptParams,
  config: Pick<PiHarnessConfig, "leanPromptTriggers" | "promptContextMode"> = {},
): string {
  const shaped = params as PromptParamsShape;
  const trigger = shaped.trigger;
  const rawPrompt = shaped.prompt ?? "";

  if (config.promptContextMode !== "lean-automation" || !trigger) {
    return prependExtraSystemPrompt(rawPrompt, shaped.extraSystemPrompt);
  }

  const leanTriggers = new Set<PiHarnessTrigger>(
    config.leanPromptTriggers?.length ? config.leanPromptTriggers : DEFAULT_LEAN_PROMPT_TRIGGERS,
  );

  if (!leanTriggers.has(trigger)) {
    return prependExtraSystemPrompt(rawPrompt, shaped.extraSystemPrompt);
  }

  const userPrompt = prependCurrentInboundContext(
    normalizeText(shaped.transcriptPrompt) ?? normalizeText(rawPrompt) ?? "",
    shaped.currentInboundContext,
  );
  const sections = [...buildLowDepthContract(trigger)];
  const extraSystemPrompt = normalizeText(shaped.extraSystemPrompt);
  if (extraSystemPrompt) {
    sections.push("", "Additional system instructions:", extraSystemPrompt);
  }
  sections.push("", "Current turn:", userPrompt);

  const contextLines = formatCurrentTurnContext(shaped.currentTurnContext);
  if (contextLines.length > 0) {
    sections.push("", ...contextLines);
  }

  return `${sections.join("\n").trim()}\n`;
}
