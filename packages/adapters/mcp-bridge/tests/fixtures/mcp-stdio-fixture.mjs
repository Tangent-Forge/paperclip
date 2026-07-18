import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "echo";
const extraArgs = process.argv.slice(3);
let callCount = 0;
const safeEnv = { PAPERCLIP_TEST_FLAG: process.env.PAPERCLIP_TEST_FLAG ?? null };
const server = new Server({ name: "paperclip-mcp-fixture", version: "0.1.0" }, { capabilities: { tools: {} } });

const tools = ["echo", "tool-error", "delay", "bad-protocol", "oversized"];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((name) => ({
    name,
    description:
      name === "echo"
        ? "echo incoming input"
        : name === "tool-error"
          ? "return an isError result"
          : name === "delay"
            ? "delay response beyond timeout"
            : "force a malformed or protocol-breaking response",
    inputSchema: { type: "object", additionalProperties: true },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  callCount += 1;
  const { name, arguments: args } = request.params;
  if (name === "echo") {
    const received = { ...args, argv: extraArgs, cwd: process.cwd(), env: safeEnv, callCount };
    process.stderr.write("fixture-stderr-marker\n");
    return { content: [{ type: "text", text: JSON.stringify({ mode, received }) }], structuredContent: { received } };
  }
  if (name === "tool-error") {
    const taskContext = /** @type {Record<string, unknown> | undefined} */ ((args ?? {}).taskContext);
    return { isError: true, content: [{ type: "text", text: `tool error for ${taskContext?.runId ?? "unknown"}` }], structuredContent: { failed: true, taskContext, arguments: args, callCount } };
  }
  if (name === "delay") {
    const taskContext = /** @type {Record<string, unknown> | undefined} */ ((args ?? {}).taskContext);
    process.stderr.write("fixture-stderr-marker\n");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return { content: [{ type: "text", text: `late response ${taskContext?.runId ?? "unknown"}` }], structuredContent: { delayed: true, callCount } };
  }
  if (name === "bad-protocol") {
    return { content: [{ type: "text", text: "bad-protocol" }], structuredContent: { bad: true, callCount } };
  }
  if (name === "oversized") {
    const hugeText = `${"x".repeat(12000)} Bearer examplebearertoken123 token=example-token-value secret:example-secret-value authorization=Basic example-auth-value`;
    const hugeArray = Array.from({ length: 80 }, (_, index) => ({
      index,
      label: `item-${index}`,
      token: `tok-${index}`,
      nested: { secret: `nested-${index}`, text: hugeText },
    }));
    return {
      content: [{ type: "text", text: `normal text ${callCount}` }, { type: "text", text: hugeText }],
      structuredContent: {
        normal: "keep-me",
        hugeText,
        hugeArray,
        apiKey: "example-api-value",
        token: "example-token-value",
        authorization: "Bearer examplebearertoken123",
        nested: { secretValue: "example-secret-value", ok: true },
      },
    };
  }
  throw new Error(`unknown tool: ${name}`);
});

if (mode === "hang-handshake") {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} else {
  await server.connect(new StdioServerTransport());
}
