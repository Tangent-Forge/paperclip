import path from "node:path";
import { fileURLToPath } from "node:url";

const BUILT_INS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../built-ins");

export const SYNTHETIC_TODO_KV_STDIO_TEMPLATE = {
  command: process.execPath,
  args: [path.join(BUILT_INS_DIR, "synthetic-todo-kv-stdio-fixture.mjs")],
  envKeys: [] as string[],
};
