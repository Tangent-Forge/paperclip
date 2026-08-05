export const type = "kimi_local";
export const label = "Kimi Code CLI (local)";

/** Default model alias from ~/.kimi-code/config.toml */
export const DEFAULT_KIMI_LOCAL_MODEL = "kimi-code/k3";

export const models = [
  { id: DEFAULT_KIMI_LOCAL_MODEL, label: "K3 (subscription default)" },
  { id: "kimi-code/k3-256k", label: "K3-256k" },
  { id: "kimi-code/kimi-for-coding", label: "K2.7 Coding" },
  { id: "kimi-code/kimi-for-coding-highspeed", label: "K2.7 Coding Highspeed" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to run the **Kimi Code CLI** (\`kimi\`) with the local coding subscription (OAuth device login)
- You want non-interactive heartbeats via \`kimi -p\` with optional session resume

Don't use when:
- You want the Moonshot **platform API key** path (that is \`provider_router_local\` provider=kimi — different product)
- Kimi Code CLI is not installed on the Paperclip host

Core fields:
- command (string, optional): path to kimi binary (default: "kimi", or absolute path recommended)
- model (string, optional): model alias from kimi config (default: kimi-code/k3)
- cwd (string, optional): working directory
- promptTemplate (string, optional): run prompt template
- auto (boolean, optional): pass --auto for fully autonomous tool use (default: true)
- yolo (boolean, optional): pass -y auto-approve tools (default: true)
- extraArgs (string[], optional): extra CLI args
- env (object, optional): extra environment variables
- timeoutSec (number, optional): run timeout seconds (0 = none)
- graceSec (number, optional): SIGTERM grace seconds

Auth:
- Uses local Kimi Code OAuth credentials under \`~/.kimi-code/credentials/\`
- Run \`kimi login\` on the host once; no KIMI_API_KEY / Moonshot platform key required
`;
