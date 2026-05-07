import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createGumroadClient } from "./client.js";
import { gumroadTools } from "./tools.js";

export function createGumroadMcpServer() {
  const server = new Server(
    { name: "gumroad", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: gumroadTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(tool.schema.shape).map(([key, schema]) => [key, { description: (schema as { description?: string }).description }]),
        ),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = gumroadTools.find((t) => t.name === request.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }

    try {
      const client = createGumroadClient();
      const result = await tool.execute(request.params.arguments as Record<string, unknown>, client);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

export async function runStdio() {
  const server = createGumroadMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
