import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listToolsFromServer,
  resolveAdaptorMcpServerEntries,
  resolveAdaptorToolsCatalog,
} from "./adaptor-catalog.js";

const FAKE_SERVER_SCRIPT = join(__dirname, "test-fixtures", "fake-mcp-server.mjs");
// Mirrors adaptor-catalog.ts's own findOpenClawAppRoot() result: this test
// file sits at extensions/pi-fork/ (two levels below the OpenClaw app root's
// package.json), same as adaptor-catalog.ts's own THIS_DIR when vitest runs
// it as raw TypeScript source (no tsdown bundling/chunk-hoisting involved),
// so both land on the identical real app root — not a mirrored copy of a
// fixed-depth formula (see adaptor-catalog.ts's PATH RESOLUTION note for why
// that was the original bug: the compiled module can be bundled into a
// shared chunk at an unpredictable depth, which a fixed-depth resolve()
// can't account for).
const EXPECTED_APP_ROOT = resolve(__dirname, "../../");
const EXPECTED_MCP_DIR = join(EXPECTED_APP_ROOT, "dist", "mcp");

describe("listToolsFromServer", () => {
  it("spawns a real MCP stdio server and returns its catalog, prefixed and shaped for adaptorTools", async () => {
    const tools = await listToolsFromServer({ id: "fake", scriptPath: FAKE_SERVER_SCRIPT });

    expect(tools).toEqual([
      {
        name: "oc__fake__fake_tool_a",
        server: "fake",
        tool: "fake_tool_a",
        description: "First fake tool for adaptor-catalog tests.",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      },
      {
        name: "oc__fake__fake_tool_b",
        server: "fake",
        tool: "fake_tool_b",
        description: "Second fake tool for adaptor-catalog tests.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("returns an empty catalog instead of throwing when the server script does not exist", async () => {
    const tools = await listToolsFromServer({
      id: "missing",
      scriptPath: "/definitely/missing/server.js",
    });

    expect(tools).toEqual([]);
  });
});

describe("resolveAdaptorToolsCatalog", () => {
  it("returns an explicit non-empty config.adaptorTools verbatim as a manual override", async () => {
    const manual = [{ name: "oc__manual__x", server: "manual", tool: "x" }];

    const catalog = await resolveAdaptorToolsCatalog({ adaptorTools: manual });

    expect(catalog).toBe(manual);
  });

  it("live-resolves the real built-in servers' catalog when built, or empty when dist/mcp isn't built yet", async () => {
    // This machine's dist/mcp may or may not be built depending on whether a
    // build ran before the test suite — both are valid states, so assert
    // against real disk state rather than hardcoding either outcome (a
    // hardcoded [] here is exactly what let the original bundler-hoisting
    // path bug go undetected: it was tautologically true under the bug and
    // stayed true after fixing it purely by coincidence of test-machine state).
    const openClawToolsBuilt = existsSync(join(EXPECTED_MCP_DIR, "openclaw-tools-serve.js"));
    const pluginToolsBuilt = existsSync(join(EXPECTED_MCP_DIR, "plugin-tools-serve.js"));

    const catalog = await resolveAdaptorToolsCatalog({});

    if (!openClawToolsBuilt && !pluginToolsBuilt) {
      expect(catalog).toEqual([]);
      return;
    }
    expect(Array.isArray(catalog)).toBe(true);
    for (const tool of catalog) {
      expect(tool.name).toMatch(/^oc__/);
    }
    if (openClawToolsBuilt) {
      expect(catalog.some((tool) => tool.name === "oc__openclaw-tools__cron")).toBe(true);
    }
  });
});

describe("resolveAdaptorMcpServerEntries", () => {
  it("includes an entry for a server whose script exists, with cwd pinned to the app root", async () => {
    const entries = resolveAdaptorMcpServerEntries([
      { id: "fake", scriptPath: FAKE_SERVER_SCRIPT },
    ]);

    expect(entries).toEqual({
      fake: {
        command: process.execPath,
        args: [FAKE_SERVER_SCRIPT],
        cwd: EXPECTED_APP_ROOT,
      },
    });
  });

  it("omits a server whose script does not exist", async () => {
    const entries = resolveAdaptorMcpServerEntries([
      { id: "missing", scriptPath: "/definitely/missing/server.js" },
    ]);

    expect(entries).toEqual({});
  });

  it("reflects whichever real built-in MCP server scripts actually exist in dist/mcp for this checkout", async () => {
    // Same rationale as the resolveAdaptorToolsCatalog live-resolve test
    // above: assert against real disk state, not a hardcoded assumption —
    // this is what actually proves entries are only ever emitted for
    // scripts that are really there, with the cwd correctly pinned to the
    // real OpenClaw app root (not a phantom path a bundler-hoisted chunk
    // would silently miss).
    const pluginToolsPath = join(EXPECTED_MCP_DIR, "plugin-tools-serve.js");
    const openClawToolsPath = join(EXPECTED_MCP_DIR, "openclaw-tools-serve.js");

    const entries = resolveAdaptorMcpServerEntries();

    if (existsSync(pluginToolsPath)) {
      expect(entries["openclaw-plugin-tools"]).toEqual({
        command: process.execPath,
        args: [pluginToolsPath],
        cwd: EXPECTED_APP_ROOT,
      });
    } else {
      expect(entries["openclaw-plugin-tools"]).toBeUndefined();
    }

    if (existsSync(openClawToolsPath)) {
      expect(entries["openclaw-tools"]).toEqual({
        command: process.execPath,
        args: [openClawToolsPath],
        cwd: EXPECTED_APP_ROOT,
      });
    } else {
      expect(entries["openclaw-tools"]).toBeUndefined();
    }
  });
});
