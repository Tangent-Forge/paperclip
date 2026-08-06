#!/usr/bin/env bash
# PAP-1758 D4 self-heal wrapper for systemd timer.
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 26 >/dev/null 2>&1 || true
DEPLOY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---apply}"
ALERT_FLAG="${2:---alert}"
exec node "$DEPLOY_ROOT/scripts/paperclip-run-log-security-scan.mjs" "$MODE" "$ALERT_FLAG"
