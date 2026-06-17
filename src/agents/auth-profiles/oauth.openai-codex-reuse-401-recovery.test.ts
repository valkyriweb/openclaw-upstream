import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createExpiredOauthStore,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  removeOAuthTestTempRoot,
  resetOAuthProviderRuntimeMocks,
  resolveApiKeyForProfileInTest,
} from "./oauth-test-utils.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;
let isRefreshTokenReusedError: typeof import("./oauth.js").isRefreshTokenReusedError;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest, isRefreshTokenReusedError } =
    await import("./oauth.js"));
}

vi.mock("@earendil-works/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai-codex" }],
}));

// Keep the external-CLI credential readers hermetic: never read the operator's
// real ~/.codex on a laptop test run, and don't let an external fallback mask
// the recovery path under test.
vi.mock("./external-cli-sync.js", async (importActual) => ({
  ...(await importActual<typeof import("./external-cli-sync.js")>()),
  readExternalCliFallbackCredential: () => null,
  readManagedExternalCliCredential: () => null,
}));

describe("OpenAI Codex bare-401 rotation recovery (#26322 residual gap)", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let mainAgentDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-codex-reuse-");
    mainAgentDir = await createOAuthMainAgentDir(tempRoot);
    await loadOAuthModuleForTest();
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    if (resetOAuthRefreshQueuesForTest) {
      resetOAuthRefreshQueuesForTest();
    }
    await removeOAuthTestTempRoot(tempRoot);
  });

  describe("isRefreshTokenReusedError classifies the Codex bare 401", () => {
    it("treats a Codex token-refresh 401 (empty body) as a reuse/rotation signal", () => {
      expect(
        isRefreshTokenReusedError(new Error("OpenAI Codex token refresh failed (401): {}")),
      ).toBe(true);
    });

    it("classifies the wrapped manager error message too", () => {
      expect(
        isRefreshTokenReusedError(
          new Error(
            "OAuth token refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {}",
          ),
        ),
      ).toBe(true);
    });

    it("still recognizes explicit reuse markers", () => {
      expect(isRefreshTokenReusedError(new Error("refresh_token_reused"))).toBe(true);
    });

    it("does not over-match non-401 Codex refresh failures", () => {
      expect(
        isRefreshTokenReusedError(new Error("OpenAI Codex token refresh failed (500): boom")),
      ).toBe(false);
      expect(isRefreshTokenReusedError(new Error("ECONNRESET"))).toBe(false);
    });

    it("does not classify a Codex 401 carrying an explicit re-auth reason as reuse", () => {
      // A 401 that means the token is invalid/revoked or the user must sign in
      // again is genuine re-auth, not a concurrent-rotation race.
      expect(
        isRefreshTokenReusedError(
          new Error(
            'OpenAI Codex token refresh failed (401): {"error":"invalid_grant","error_description":"Token expired or revoked."}',
          ),
        ),
      ).toBe(false);
      expect(
        isRefreshTokenReusedError(
          new Error("OpenAI Codex token refresh failed (401): please sign in again"),
        ),
      ).toBe(false);
    });
  });

  it("recovers the rotated credential after a bare 401 instead of surfacing a FailoverError", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const STALE_REFRESH = "stale-single-use-refresh";
    const ROTATED_REFRESH = "peer-rotated-refresh";
    const RECOVERED_ACCESS = "recovered-after-retry-access";

    const loserAgentDir = path.join(tempRoot, "agents", "sub-loser", "agent");
    await fs.mkdir(loserAgentDir, { recursive: true });

    // Loser + main both hold the SAME expired credential carrying the stale,
    // already-consumed refresh token. Main is also expired so it cannot
    // short-circuit recovery via main-store adoption.
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId, refresh: STALE_REFRESH }),
      loserAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId, refresh: STALE_REFRESH }),
      mainAgentDir,
    );

    let refreshCalls = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async (params: unknown) => {
      refreshCalls += 1;
      const presented = (params as { context: OAuthCredential }).context.refresh;
      if (presented === STALE_REFRESH) {
        // A peer consumed the single-use refresh token first: its rotation
        // landed in this agent's shared store as a new refresh lineage whose
        // access token is not yet minted here, and our now-stale token is
        // rejected with the bare Codex 401 (empty body, no reuse marker).
        const rotated: AuthProfileStore = {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider,
              access: "rotated-but-still-expired-access",
              refresh: ROTATED_REFRESH,
              expires: Date.now() - 30_000,
              accountId,
            },
          },
        };
        saveAuthProfileStore(rotated, loserAgentDir);
        throw new Error("OpenAI Codex token refresh failed (401): {}");
      }
      if (presented === ROTATED_REFRESH) {
        return {
          type: "oauth",
          provider,
          access: RECOVERED_ACCESS,
          refresh: "next-refresh",
          expires: freshExpiry,
          accountId,
        } as never;
      }
      throw new Error(`unexpected refresh token presented: ${presented}`);
    });

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(loserAgentDir),
      profileId,
      agentDir: loserAgentDir,
    });

    if (!result) {
      throw new Error("Expected a recovered OAuth credential, got null");
    }
    // Loser re-reads the rotated shared store and retries with the fresh
    // lineage rather than surfacing the 401.
    expect(result.apiKey).toBe(RECOVERED_ACCESS);
    expect(result.provider).toBe(provider);
    // First attempt rejected (stale → 401), recovery retried with the rotated
    // refresh token.
    expect(refreshCalls).toBe(2);
  }, 10_000);
});
