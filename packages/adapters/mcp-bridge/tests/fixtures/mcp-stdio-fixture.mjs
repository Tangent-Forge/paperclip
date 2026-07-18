import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mode = process.argv[2] ?? "echo";
const extraArgs = process.argv.slice(3);
const server = new McpServer({ name: "paperclip-mcp-fixture", version: "0.1.0" });

server.tool("echo", "echo incoming input", { taskContext: { type: "object" } }, async ({ taskContext, ...rest }) => {
  process.stderr.write("fixture-stderr-marker\n");
  return {
    content: [{ type: "text", text: `hello from fixture: ${mode}` }],
    structuredContent: { received: { taskContext, ...rest, argv: extraArgs, cwd: process.cwd(), env: { PAPERCLIP_TEST_FLAG: process.env.PAPERCLIP_TEST_FLAG ?? null } } },
  };
});

server.tool("tool-error", "return an isError result", { taskContext: { type: "object" } }, async ({ taskContext }) => ({
  isError: true,
  content: [{ type: "text", text: `tool error for ${taskContext?.runId ?? "unknown"}` }],
  structuredContent: { failed: true, taskContext },
}));

server.tool("delay", "delay response beyond timeout", { taskContext: { type: "object" } }, async ({ taskContext }) => {
  process.stderr.write("fixture-stderr-marker\n");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return { content: [{ type: "text", text: `late response ${taskContext?.runId ?? "unknown"}` }], structuredContent: { delayed: true } };
});

server.tool("bad-protocol", "force a malformed response", { taskContext: { type: "object" } }, async () => {
  return { content: "not-an-array" as unknown as never };
});

await server.connect(new StdioServerTransport());
