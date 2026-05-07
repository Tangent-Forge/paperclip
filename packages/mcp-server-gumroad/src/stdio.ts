import { runStdio } from "./index.js";

runStdio().catch((error) => {
  console.error("Gumroad MCP server error:", error);
  process.exit(1);
});
