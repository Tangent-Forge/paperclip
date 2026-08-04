import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_QWEN_LOCAL_MODEL } from "../index.js";

export function buildQwenLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  ac.model = v.model || DEFAULT_QWEN_LOCAL_MODEL;
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  if (v.command) ac.command = v.command;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return ac;
}
