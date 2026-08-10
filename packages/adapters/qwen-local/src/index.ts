export const type = "qwen_local";
export const label = "Qwen Code CLI (local)";

/** Default to Token Plan GLM 5.2 when available */
export const DEFAULT_QWEN_LOCAL_MODEL = "glm-5.2";

/** Full Alibaba ModelStudio Token Plan catalog (shared env key BAILIAN_TOKEN_PLAN_API_KEY). */
export const models = [
  { id: "glm-5.2", label: "GLM 5.2 (Token Plan)" },
  { id: "glm-5.1", label: "GLM 5.1 (Token Plan)" },
  { id: "glm-5", label: "GLM 5 (Token Plan)" },
  { id: "qwen3.7-plus", label: "Qwen 3.7 Plus (Token Plan)" },
  { id: "qwen3.6-plus", label: "Qwen 3.6 Plus (Token Plan)" },
  { id: "qwen3.7-max", label: "Qwen 3.7 Max (Token Plan)" },
  { id: "qwen3.8-max-preview", label: "Qwen 3.8 Max Preview (Token Plan)" },
  { id: "qwen3.6-flash", label: "Qwen 3.6 Flash (Token Plan)" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro (Token Plan)" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash (Token Plan)" },
  { id: "deepseek-v3.2", label: "DeepSeek V3.2 (Token Plan)" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code (Token Plan)" },
  { id: "kimi-k2.6", label: "Kimi K2.6 (Token Plan)" },
  { id: "kimi-k2.5", label: "Kimi K2.5 (Token Plan)" },
  { id: "MiniMax-M2.5", label: "MiniMax M2.5 (Token Plan)" },
];

export const agentConfigurationDoc = `# qwen_local agent configuration

Adapter: qwen_local

Use when:
- You want Paperclip to run the **Qwen Code CLI** (\`qwen\`) with Alibaba ModelStudio **Token Plan** or **Coding Plan** subscription credentials
- You want models like glm-5.2 / qwen3.x via the Qwen Code headless path (\`qwen -p\`)

Don't use when:
- Qwen Code is not installed on the Paperclip host
- You only need a raw HTTP provider call without the coding agent (use provider_router_local)

Core fields:
- command (string, optional): path to qwen binary (default: "qwen")
- model (string, optional): model id (default: glm-5.2)
- cwd (string, optional): working directory
- promptTemplate (string, optional): run prompt template
- extraArgs (string[], optional): extra CLI args
- env (object, optional): extra environment variables (use for BAILIAN_TOKEN_PLAN_API_KEY if not in host env)
- timeoutSec / graceSec: operational timeouts

Auth (Token Plan — preferred for glm-5.2):
- Set host env \`BAILIAN_TOKEN_PLAN_API_KEY\` (from ModelStudio Token Plan)
- Configure \`~/.qwen/settings.json\` with Token Plan base URL + selectedType openai
  - China: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
  - Intl:  https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
- Or run interactive \`qwen\` then \`/auth\` → Alibaba ModelStudio → Token Plan

Auth (Coding Plan alternative):
- \`BAILIAN_CODING_PLAN_API_KEY\` + coding.dashscope base URL

Note: This is **not** free Qwen OAuth (discontinued). Token/Coding Plan subscription keys are required.
`;
