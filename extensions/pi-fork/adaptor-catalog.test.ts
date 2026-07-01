import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listToolsFromServer,
  resolveAdaptorMcpServerEntries,
  resolveAdaptorToolsCatalog,
} from "./adaptor-catalog.js";

const FAKE_SERVER_SCRIPT = join(__dirname, "test-fixtures", "fake-mcp-server.mjs");
// Mirrors adaptor-catalog.ts's own THIS_DIR/MCP_DIR/APP_ROOT arithmetic
// (this test file sits next to adaptor-catalog.ts, so the relative math
// lands on the identical value that module computes for itself — note this
// intentionally differs from the built container's /app, since there's no
// dist/ layer in a source/test run; see adaptor-catalog.ts's PATH RESOLUTION note).
const EXPECTED_MCP_DIR = resolve(__dirname, "../../mcp");
const EXPECTED_APP_ROOT = resolve(EXPECTED_MCP_DIR, "../../");

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

  it("live-resolves to an empty catalog without throwing when no adaptorTools override is set", async () => {
    // In this test environment (raw TS source, no dist/ build) the real MCP
    // server scripts do not exist at their computed paths, so this exercises
    // the safe-degradation path rather than a real bridge — see
    // adaptor-catalog.ts's PATH RESOLUTION note.
    const catalog = await resolveAdaptorToolsCatalog({});

    expect(catalog).toEqual([]);
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

  it("resolves to no entries for the real built-in servers in this test environment", async () => {
    // Same rationale as the resolveAdaptorToolsCatalog live-resolve test above:
    // proves this never accidentally writes real mcporter.json server entries
    // during a source/test run.
    const entries = resolveAdaptorMcpServerEntries();

    expect(entries).toEqual({});
  });
});
