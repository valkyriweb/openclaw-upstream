#!/usr/bin/env node
/**
 * Minimal standalone MCP stdio server fixture for adaptor-catalog.test.ts.
 *
 * Deliberately independent of OpenClaw's own mcp/tools-stdio-server.ts
 * (extensions/ cannot import src/ runtime code across the TS project
 * boundary) — this proves listToolsFromServer works against a generic,
 * spec-compliant MCP server, not just against OpenClaw's own twin
 * implementation.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fake-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fake_tool_a",
      description: "First fake tool for adaptor-catalog tests.",
      inputSchema: {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
      },
    },
    {
      name: "fake_tool_b",
      description: "Second fake tool for adaptor-catalog tests.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
