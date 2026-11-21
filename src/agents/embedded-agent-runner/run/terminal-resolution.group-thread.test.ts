import { describe, expect, it } from "vitest";
import { runGroupThread } from "../../../auto-reply/group-thread.js";
import type { ResolvedGroupThreadConfig } from "../../../auto-reply/group-thread.types.js";
import {
  expectComplete,
  resolveTerminal,
  textAssistant,
} from "./terminal-resolution.test-support.js";

type ParticipantResult = Awaited<ReturnType<typeof resolveTerminal>>;

const primaryAgentId = "centaur-team";
const secondaryAgentId = "d90-damian";

function makeGroup(agents = [primaryAgentId, secondaryAgentId]): ResolvedGroupThreadConfig {
  return {
    agents,
    unknownAgentIds: [],
    qualified: true,
    configuredAgentCount: agents.length,
    mentionGating: true,
    maxRounds: 1,
    maxTurns: agents.length,
    strategy: "parallel",
  };
}

async function runParticipants(params: {
  agents?: string[];
  mentionedAgentIds?: string[];
  replies: Record<string, string>;
  exhaustedReplyRetriesFor?: string[];
}) {
  const outcomes = new Map<string, ParticipantResult>();
  const errors: unknown[] = [];
  const group = makeGroup(params.agents);
  const run = await runGroupThread({
    cfg: {},
    group,
    channel: "whatsapp",
    peerId: "120363409551065841@g.us",
    text: "Please review the update.",
    primaryAgentId,
    mentionedAgentIds: params.mentionedAgentIds,
    async runTurn(turn) {
      const text = params.replies[turn.agentId] ?? "NO_REPLY";
      const silent = text.trim().toUpperCase() === "NO_REPLY";
      const result = await resolveTerminal({
        assistant: textAssistant(text),
        attemptOverrides: {
          assistantTexts: [text],
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        },
        finalAssistantRawText: text,
        payloadsWithToolMedia: silent || !text.trim() ? [] : [{ text }],
        retryState: {
          emptyResponseAttempts: params.exhaustedReplyRetriesFor?.includes(turn.agentId) ? 1 : 0,
        },
        runParams: { terminalReplyExpectation: "result-required" },
      });
      outcomes.set(turn.agentId, result);
      return result;
    },
    onError(error) {
      errors.push(error);
    },
  });
  expect(errors).toEqual([]);
  return { outcomes, run };
}

function completedResult(outcome: ParticipantResult | undefined) {
  if (!outcome) {
    throw new Error("missing participant outcome");
  }
  expectComplete(outcome);
  return outcome.result;
}

describe("broadcast participant NO_REPLY", () => {
  it("keeps the primary answer when an unaddressed secondary is silent", async () => {
    const { outcomes } = await runParticipants({
      replies: { [primaryAgentId]: "The team answer is ready.", [secondaryAgentId]: "NO_REPLY" },
    });

    expect(outcomes.get(primaryAgentId)).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: "The team answer is ready." }],
        meta: { terminalReplyExpectation: "result-required" },
      },
    });
    expect(completedResult(outcomes.get(primaryAgentId)).meta).not.toHaveProperty("error");
    expect(outcomes.get(secondaryAgentId)).toMatchObject({
      action: "complete",
      result: {
        payloads: undefined,
        meta: {
          terminalReply: { disposition: "silent" },
          terminalReplyExpectation: "optional",
        },
      },
    });
  });

  it("accepts secondary silence but preserves the primary required-reply failure", async () => {
    const { outcomes } = await runParticipants({
      replies: { [primaryAgentId]: "NO_REPLY", [secondaryAgentId]: "NO_REPLY" },
      exhaustedReplyRetriesFor: [primaryAgentId],
    });

    expect(outcomes.get(primaryAgentId)).toMatchObject({
      action: "complete",
      result: {
        meta: { terminalReplyExpectation: "result-required", error: { kind: "incomplete_turn" } },
      },
    });
    expect(outcomes.get(secondaryAgentId)).toMatchObject({
      action: "complete",
      result: { meta: { terminalReplyExpectation: "optional" } },
    });
    expect(completedResult(outcomes.get(secondaryAgentId)).meta).not.toHaveProperty("error");
  });

  it("does not exempt an explicitly addressed secondary or non-exact sentinel text", async () => {
    const addressed = await runParticipants({
      mentionedAgentIds: [secondaryAgentId],
      replies: { [secondaryAgentId]: "NO_REPLY" },
      exhaustedReplyRetriesFor: [secondaryAgentId],
    });
    expect(addressed.outcomes.get(secondaryAgentId)).toMatchObject({
      action: "complete",
      result: {
        meta: {
          terminalReplyExpectation: "result-required",
          error: { kind: "incomplete_turn" },
        },
      },
    });

    const nonExact = await runParticipants({
      replies: { [primaryAgentId]: "Team answer", [secondaryAgentId]: "NO_REPLY." },
    });
    expect(nonExact.outcomes.get(secondaryAgentId)).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: "NO_REPLY." }],
        meta: {
          terminalReplyExpectation: "result-required",
          terminalReply: { disposition: "visible", text: "NO_REPLY." },
        },
      },
    });
  });

  it("does not exempt empty output from the secondary silence rule", async () => {
    const { outcomes } = await runParticipants({
      replies: { [primaryAgentId]: "Team answer", [secondaryAgentId]: "" },
      exhaustedReplyRetriesFor: [secondaryAgentId],
    });

    expect(outcomes.get(secondaryAgentId)).toMatchObject({
      action: "complete",
      result: {
        meta: {
          terminalReplyExpectation: "result-required",
          terminalReply: { disposition: "empty" },
          error: { kind: "incomplete_turn" },
        },
      },
    });
  });

  it("keeps single-agent required replies unchanged", async () => {
    const { outcomes } = await runParticipants({
      agents: [primaryAgentId],
      replies: { [primaryAgentId]: "NO_REPLY" },
      exhaustedReplyRetriesFor: [primaryAgentId],
    });

    expect(outcomes.get(primaryAgentId)).toMatchObject({
      action: "complete",
      result: {
        meta: { terminalReplyExpectation: "result-required", error: { kind: "incomplete_turn" } },
      },
    });
  });
});
