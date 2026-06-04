import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
/**
 * Synthetic "pi" provider for the Pi Fork plugin.
 *
 * Model refs: pi/claude-opus-4-8, pi/claude-opus-4-7, pi/claude-sonnet-4-5, etc.
 * Auth: synthetic (pi CLI manages credentials; OpenClaw does not inject API keys).
 */
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";

export const PI_PROVIDER_ID = "pi-fork";
export const PI_AUTH_MARKER = "pi-fork-cli";
/** Placeholder base URL — pi uses stdio/RPC, not HTTP. Present to satisfy ModelProviderConfig shape. */
export const PI_BASE_URL = "pi-fork://localhost";

/** Static model catalog mirroring pi-mono-fork's default provider defaults. */
const PI_FALLBACK_MODELS: ModelDefinitionConfig[] = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8 (Pi)",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Opus 4.8 via claude-bridge exposes a 1M context window (matches
    // managed-runtime DEFAULT_PI_HARNESS_MODELS + ~/.pi/agent/models.json).
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    compat: { supportsTools: true },
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7 (Pi)",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    compat: { supportsTools: true },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Pi)",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    compat: { supportsTools: true },
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (Pi)",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_000,
    compat: { supportsTools: true },
  },
];

function buildPiProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: PI_BASE_URL,
    apiKey: PI_AUTH_MARKER,
    auth: "token",
    api: "anthropic-messages",
    models: PI_FALLBACK_MODELS,
  };
}

export function buildPiProvider(): ProviderPlugin {
  return {
    id: PI_PROVIDER_ID,
    label: "Pi",
    docsPath: "/providers/models",

    auth: [
      {
        id: "pi-cli",
        label: "Pi CLI (managed)",
        hint: "Pi manages its own credentials. Run `pi auth` inside pi-mono-fork to log in.",
        kind: "custom",
        wizard: {
          choiceId: PI_PROVIDER_ID,
          choiceLabel: "Pi (pi-mono-fork)",
          choiceHint: "Route agent turns through the pi coding-agent RPC runtime.",
          assistantPriority: -50,
          groupId: PI_PROVIDER_ID,
          groupLabel: "Pi",
          groupHint: "Pi coding-agent harness",
          onboardingScopes: ["text-inference"],
        },
        run: async () => ({
          profiles: [],
          defaultModel: `${PI_PROVIDER_ID}/${PI_FALLBACK_MODELS[0].id}`,
        }),
      },
    ],

    /** Static catalog — shown without network I/O. */
    staticCatalog: {
      order: "late",
      run: async () => ({ provider: buildPiProviderConfig() }),
    },

    /**
     * Optimistically resolve any pi/<modelId> the user requests,
     * even if it's not in the static list.
     */
    resolveDynamicModel: (ctx): ProviderRuntimeModel | null => {
      const { modelId } = ctx;
      if (!modelId) {
        return null;
      }
      return {
        id: modelId,
        name: `${modelId} (Pi)`,
        api: "anthropic-messages",
        reasoning: false,
        input: ["text"] as Array<"text" | "image">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_000,
        compat: { supportsTools: true },
        provider: PI_PROVIDER_ID,
        baseUrl: PI_BASE_URL,
      } as ProviderRuntimeModel;
    },

    /** Pi CLI manages auth — supply a synthetic non-secret marker. */
    resolveSyntheticAuth: () => ({
      apiKey: PI_AUTH_MARKER,
      source: "pi-cli",
      mode: "token" as const,
    }),
  };
}
