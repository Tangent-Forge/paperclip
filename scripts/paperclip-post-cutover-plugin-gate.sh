#!/usr/bin/env bash
# Post-cutover gate for Paperclip deploys:
# 1) optional durable materialize of first-party local plugins from the new pin
# 2) hard fail if any enabled/installed plugin remains in error or has a dead packagePath
#
# Usage:
#   paperclip-post-cutover-plugin-gate.sh <deploy_root> [base_url]
set -euo pipefail

DEPLOY_ROOT="${1:?usage: paperclip-post-cutover-plugin-gate.sh <deploy_root> [base_url]}"
BASE_URL="${2:-${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}}"
BASE_URL="${BASE_URL%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$DEPLOY_ROOT" ]; then
  echo "error: deploy root does not exist: $DEPLOY_ROOT" >&2
  exit 1
fi

# Wait briefly for API readiness after restart.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -m 3 "$BASE_URL/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS -m 5 "$BASE_URL/api/health" >/dev/null

# Prefer materializing known first-party plugin paths from the new pin when present.
LINEAR_SRC="$DEPLOY_ROOT/packages/plugins/paperclip-plugin-linear-sync"
if [ -d "$LINEAR_SRC" ]; then
  echo "==> Ensuring linear-sync is installed durable from new pin"
  # If already installed, materialize script will soft-uninstall+reinstall.
  bash "$SCRIPT_DIR/paperclip-materialize-local-plugins.sh" "$BASE_URL" "paperclipai.linear-sync" || {
    # If plugin key filter skipped because path missing, try install fresh.
    curl -fsS -X POST "$BASE_URL/api/plugins/install" \
      -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"packageName":sys.argv[1],"isLocalPath":True,"durable":True}))' "$LINEAR_SRC")" \
      >/tmp/pc-linear-install.json || true
  }
fi

bash "$SCRIPT_DIR/paperclip-enabled-plugins-health-gate.sh" "$BASE_URL"
echo "post-cutover plugin gate passed for $DEPLOY_ROOT"
