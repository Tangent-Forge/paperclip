import type { AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, models, type } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { getConfigSchema } from "./config-schema.js";
import { listDevinModels } from "./models.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    listModels: () => listDevinModels(),
    refreshModels: () => listDevinModels(true),
    getConfigSchema,
    agentConfigurationDoc,
  };
}

export { execute, testEnvironment, listDevinModels };
export { getConfigSchema } from "./config-schema.js";
export type { AdapterModel };
