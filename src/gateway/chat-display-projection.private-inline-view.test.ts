import { expect, it } from "vitest";
import {
  bindPluginInlineViewInvocation,
  createPluginInlineViewResult,
} from "../plugins/inline-view.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { prepareAgentWirePayload } from "./server-chat-live-text.js";
import { createChatRunState } from "./server-chat-state.js";

it.each(["direct", "nested"] as const)(
  "replays only the opaque private view reference (%s)",
  (kind) => {
    const runId = "fixture-run";
    const pluginId = "private-view-fixture";
    const viewId = "private-answer";
    const toolName = "private_read";
    const toolCallId = kind === "direct" ? "direct-read" : "tool_call:parent:private_read:1";
    const summary = "Answer visible to its requester";
    const payload = { resultId: "0123456789abcdef0123456789abcdef" };
    const stored = bindPluginInlineViewInvocation(
      createPluginInlineViewResult(pluginId, viewId, payload, { version: 1, summary }),
      pluginId,
      toolName,
      toolCallId,
    );
    const state = createChatRunState();
    try {
      const wire = prepareAgentWirePayload(
        {
          runId,
          seq: 1,
          ts: 2,
          stream: "tool",
          data: { phase: "result", name: toolName, toolCallId, result: stored, isError: false },
        },
        runId,
        state,
        () => true,
      );
      const expected = {
        type: "plugin_view",
        pluginId,
        viewId,
        payload,
        summary,
        toolName,
        toolCallId,
        version: 1,
      };
      expect(wire.data.result).toMatchObject({
        content: stored.content,
        details: { pluginView: expected },
      });
      const row =
        kind === "direct"
          ? { role: "toolResult", toolCallId, toolName, ...stored, isError: false, timestamp: 2 }
          : createNestedToolActivity({
              runId,
              scopeId: "scope",
              afterEntryId: null,
              startOrder: 0,
              toolCallId,
              toolName,
              input: {},
              result: stored,
              isError: false,
              startedAt: 1,
              timestamp: 2,
            });
      const restored = JSON.stringify(projectChatDisplayMessages([row]));
      expect(restored).toContain(summary);
      expect(restored).toContain(JSON.stringify(expected.payload));
      expect(restored).toContain('"type":"plugin_view"');
    } finally {
      state.clear();
    }
  },
);
