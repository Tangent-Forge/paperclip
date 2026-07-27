import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): absolute http(s) endpoint to invoke with POST
- headers (object, optional): JSON headers forwarded with each request
- payloadTemplate (object, optional): JSON object shallow-merged into the request body
- method (string, optional): HTTP method, defaults to POST
- timeoutMs (number, optional): request timeout in milliseconds

Default request body:
- issue: issue title from the run context when available
- description: issue description from the run context when available
- tools: configured tools resolved for the run
- agentId, agentName, companyId, runId: identifying metadata for the run

Notes:
- payloadTemplate overrides the default body fields when keys overlap
- non-2xx responses are returned as adapter errors with the upstream body attached
`,
};
