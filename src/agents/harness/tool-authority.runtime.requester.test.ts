import { expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { FailoverError } from "../failover-error.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { preparePluginToolExecutionCapabilities } from "../plugin-tool-execution.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";
import { admitted, attempt } from "./tool-authority.runtime.test-support.js";

const operator = (profileId: string, assertCurrent = () => {}) =>
  createAdmittedRunOperatorAuthority({ profileId, scopes: ["operator.write"], assertCurrent });
const ui = (profileId: string) => ({ connId: "fixture-connection", profileId });
const readPluginRequester = (sessionKey = attempt.sessionKey) =>
  preparePluginToolExecutionCapabilities({ sessionKey })(() => {}).runtimeContext
    ?.readRequesterProfileId;

it("binds each retry to the authenticated turn requester, not the previous attempt or a reader", async () => {
  const selected: string[] = [];
  let first: (() => string | undefined) | undefined;
  await admitted(async ({ admittedRunContext }) => {
    await runWithModelFallback({
      cfg: {},
      provider: "openai",
      model: "gpt-test",
      fallbacksOverride: ["anthropic/claude-sonnet-4-6"],
      skipAuthProfileRuntime: true,
      run: (provider, model) =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, sessionPersistence: "detached", trigger: "user" },
          { ...attempt, provider, modelId: model, gatewayUiCommandTarget: ui("first-profile") },
          undefined,
          async () => {
            const read = readPluginRequester();
            expect(read?.()).toBe("first-profile");
            expect(readPluginRequester("agent:main:other")).toBeUndefined();
            selected.push(provider);
            if (provider === "openai") {
              first = read;
              throw new FailoverError("Forced fixture fallback", {
                provider,
                model,
                reason: "model_not_found",
              });
            }
            expect(first?.()).toBeUndefined();
            return "complete";
          },
        ),
    });
  }, operator("first-profile"));
  expect(selected).toEqual(["openai", "anthropic"]);

  await admitted(async ({ admittedRunContext }) => {
    await withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext, sessionPersistence: "detached", trigger: "user" },
      { ...attempt, gatewayUiCommandTarget: ui("second-profile") },
      undefined,
      async () => {
        expect(readPluginRequester()?.()).toBe("second-profile");
        expect(first?.()).toBeUndefined();
      },
    );
  }, operator("second-profile"));
});

it.each([
  ["unbound UI", "user", undefined, undefined],
  ["mismatched operator", "user", ui("other-profile"), undefined],
  ["system input", "user", ui("first-profile"), { kind: "internal_system" }],
  ["maintenance", "memory", ui("first-profile"), undefined],
] as const)("withholds the requester for %s", async (_name, trigger, target, inputProvenance) => {
  await admitted(async ({ admittedRunContext }) => {
    await withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext, sessionPersistence: "detached", trigger },
      { ...attempt, gatewayUiCommandTarget: target, inputProvenance },
      undefined,
      async () => expect(readPluginRequester()).toBeUndefined(),
    );
  }, operator("first-profile"));
});

it("rechecks active requester authority and does not lend it to a cleared scope", async () => {
  const revoked = new AbortController();
  await admitted(async ({ admittedRunContext }) => {
    await withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext, sessionPersistence: "detached", trigger: "user" },
      { ...attempt, gatewayUiCommandTarget: ui("first-profile") },
      undefined,
      async () => {
        const read = readPluginRequester();
        expect(read?.()).toBe("first-profile");
        const caller = getGatewayToolCallerIdentity()!;
        await withGatewayToolCallerIdentity({ ...caller, readRequesterProfileId: null }, () => {
          expect(readPluginRequester()).toBeUndefined();
          expect(read?.()).toBeUndefined();
        });
        revoked.abort(new Error("Fixture requester was revoked"));
        expect(read).toThrow();
      },
    );
  }, operator("first-profile", () => revoked.signal.throwIfAborted()));
});
