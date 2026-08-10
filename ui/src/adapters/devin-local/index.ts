import type { UIAdapterModule } from "../types";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";
import { parseProcessStdoutLine } from "../process/parse-stdout";

export const devinLocalUIAdapter: UIAdapterModule = {
  type: "devin_local",
  label: "Devin (local)",
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
