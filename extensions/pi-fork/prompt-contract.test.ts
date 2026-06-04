import { describe, expect, it } from "vitest";
import { buildPiRpcPrompt } from "./prompt-contract.js";

describe("buildPiRpcPrompt", () => {
  it("passes through ordinary interactive prompts unchanged", () => {
    expect(
      buildPiRpcPrompt({
        prompt: "full OpenClaw prompt payload",
        trigger: "user",
      } as never),
    ).toBe("full OpenClaw prompt payload");
  });

  it("preserves prepared extra system policy instructions on interactive prompts", () => {
    expect(
      buildPiRpcPrompt({
        prompt: "user request",
        trigger: "user",
        extraSystemPrompt: "Tool and file actions are disabled for this sender by chat policy.",
      } as never),
    ).toBe(
      [
        "Additional system instructions:",
        "Tool and file actions are disabled for this sender by chat policy.",
        "",
        "user request",
      ].join("\n"),
    );
  });

  it("passes through heartbeat prompts unless lean automation is explicitly configured", () => {
    expect(
      buildPiRpcPrompt({
        prompt: "full heartbeat prompt payload",
        transcriptPrompt: "Check status.",
        trigger: "heartbeat",
      } as never),
    ).toBe("full heartbeat prompt payload");
  });

  it("builds a lean heartbeat prompt from transcriptPrompt and currentTurnContext when configured", () => {
    const prompt = buildPiRpcPrompt(
      {
        trigger: "heartbeat",
        prompt: "VERY LARGE FULL OPENCLAW PROMPT",
        transcriptPrompt: "Check whether anything needs attention.",
        currentInboundContext: {
          text: "Current message:\n[Replying to: keep this quiet]",
          promptJoiner: " ",
        },
        extraSystemPrompt: "Tool and file actions are disabled for this sender by chat policy.",
        currentTurnContext: {
          reply: {
            senderLabel: "Luke",
            body: "Please keep this thread quiet unless needed.",
            isQuote: true,
          },
        },
      } as never,
      { promptContextMode: "lean-automation" },
    );

    expect(prompt).toContain("Lane: heartbeat");
    expect(prompt).toContain("reply exactly HEARTBEAT_OK");
    expect(prompt).toContain("Additional system instructions:\nTool and file actions are disabled");
    expect(prompt).toContain(
      "Current turn:\nCurrent message:\n[Replying to: keep this quiet] Check whether anything needs attention.",
    );
    expect(prompt).toContain("sender: Luke");
    expect(prompt).not.toContain("VERY LARGE FULL OPENCLAW PROMPT");
  });

  it("builds a lean cron prompt with stable reply-chain formatting", () => {
    const prompt = buildPiRpcPrompt(
      {
        trigger: "cron",
        prompt: "FULL PROMPT",
        transcriptPrompt: "Rotate the weekly report and commit the result.",
        currentTurnContext: {
          replyChain: [
            {
              messageId: "m1",
              sender: "ops-bot",
              body: "Report is due.",
            },
          ],
        },
      } as never,
      { promptContextMode: "lean-automation" },
    );

    expect(prompt).toContain("Lane: cron");
    expect(prompt).toContain("avoid generic status chatter");
    expect(prompt).toContain("Current turn:\nRotate the weekly report and commit the result.");
    expect(prompt).toContain("replyChain:");
    expect(prompt).toContain("messageId: m1");
    expect(prompt).not.toContain("FULL PROMPT");
  });

  it("respects explicitly configured lean prompt triggers", () => {
    expect(
      buildPiRpcPrompt(
        {
          trigger: "heartbeat",
          prompt: "full heartbeat prompt",
          transcriptPrompt: "Heartbeat check.",
        } as never,
        { promptContextMode: "lean-automation", leanPromptTriggers: ["cron"] },
      ),
    ).toBe("full heartbeat prompt");
  });
});
