import type { UIAdapterModule } from "../types";
import { parseKimiStdoutLine, buildKimiLocalConfig } from "@paperclipai/adapter-kimi-local/ui";
import { KimiLocalConfigFields } from "./config-fields";

export const kimiLocalUIAdapter: UIAdapterModule = {
  type: "kimi_local",
  label: "Kimi Code CLI (local)",
  parseStdoutLine: parseKimiStdoutLine,
  ConfigFields: KimiLocalConfigFields,
  buildAdapterConfig: buildKimiLocalConfig,
};
