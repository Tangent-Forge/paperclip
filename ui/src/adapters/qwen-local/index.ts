import type { UIAdapterModule } from "../types";
import { parseQwenStdoutLine, buildQwenLocalConfig } from "@paperclipai/adapter-qwen-local/ui";
import { QwenLocalConfigFields } from "./config-fields";

export const qwenLocalUIAdapter: UIAdapterModule = {
  type: "qwen_local",
  label: "Qwen Code CLI (local)",
  parseStdoutLine: parseQwenStdoutLine,
  ConfigFields: QwenLocalConfigFields,
  buildAdapterConfig: buildQwenLocalConfig,
};
