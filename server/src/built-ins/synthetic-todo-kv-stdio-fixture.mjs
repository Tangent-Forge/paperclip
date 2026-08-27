#!/usr/bin/env node
import { createInterface } from "node:readline";

const todos = [
  { id: "todo-1", title: "Review Paperclip tools", done: false },
  { id: "todo-2", title: "Verify default-deny policy", done: true },
];
const values = new Map([
  ["fixture", "paperclip.synthetic-todo-kv"],
  ["mode", "deterministic"],
]);

const tools = [
  {
    name: "list_items",
    description: "List synthetic todo items.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_item",
    description: "Create a synthetic todo item.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { title: { type: "string", minLength: 1 } }, required: ["title"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "mark_done",
    description: "Mark a synthetic todo item done.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { id: { type: "string", minLength: 1 } }, required: ["id"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "delete_item",
    description: "Delete a synthetic todo item.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { id: { type: "string", minLength: 1 } }, required: ["id"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "get_value",
    description: "Read a synthetic KV value.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { key: { type: "string", minLength: 1 } }, required: ["key"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "set_value",
    description: "Write a synthetic KV value.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { key: { type: "string", minLength: 1 }, value: { type: "string" } },
      required: ["key", "value"],
    },
    annotations: { readOnlyHint: false },
  },
];

function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

function requiredString(input, key) {
  const value = input?.[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} is required`);
  return value.trim();
}

function executeTool(name, input = {}) {
  if (name === "list_items") return { items: todos.map((item) => ({ ...item })) };
  if (name === "create_item") {
    const item = { id: `todo-${todos.length + 1}`, title: requiredString(input, "title"), done: false };
    todos.push(item);
    return { item: { ...item } };
  }
  if (name === "mark_done") {
    const id = requiredString(input, "id");
    const item = todos.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Todo ${id} was not found`);
    item.done = true;
    return { item: { ...item } };
  }
  if (name === "delete_item") {
    const id = requiredString(input, "id");
    const index = todos.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Todo ${id} was not found`);
    const [item] = todos.splice(index, 1);
    return { deleted: item };
  }
  if (name === "get_value") {
    const key = requiredString(input, "key");
    return { key, value: values.get(key) ?? null };
  }
  if (name === "set_value") {
    const key = requiredString(input, "key");
    if (typeof input.value !== "string") throw new Error("value is required");
    values.set(key, input.value);
    return { key, value: input.value };
  }
  throw new Error(`Unknown tool ${name}`);
}

function responseFor(request) {
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0", id: request.id ?? null,
      result: {
        protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: { name: "paperclip-synthetic-todo-kv", version: "1.0.0" },
      },
    };
  }
  if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id ?? null, result: { tools } };
  if (request.method === "tools/call") {
    try {
      return {
        jsonrpc: "2.0", id: request.id ?? null,
        result: toolResult(executeTool(request.params?.name, request.params?.arguments)),
      };
    } catch (error) {
      return {
        jsonrpc: "2.0", id: request.id ?? null,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  return {
    jsonrpc: "2.0", id: request.id ?? null,
    error: { code: -32601, message: `Unknown method ${request.method}` },
  };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let id = null;
  try {
    const request = JSON.parse(line);
    id = request.id ?? null;
    const response = responseFor(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id,
      error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
    })}\n`);
  }
});
