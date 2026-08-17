#!/usr/bin/env bash
# Post-cutover verifier for Paperclip pins.
# Run AFTER restarting paperclip.service from the exact merged commit pin.
set -euo pipefail

BASE_URL="${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_JS="$ROOT/scripts/check-enabled-plugins-health.mjs"

echo "waiting for paperclip health at $BASE_URL ..."
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/api/health" >/tmp/paperclip-health-check.json 2>/dev/null; then
    if grep -q '"status":"ok"' /tmp/paperclip-health-check.json 2>/dev/null || grep -q '"status": "ok"' /tmp/paperclip-health-check.json 2>/dev/null; then
      break
    fi
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "paperclip health did not become ready" >&2
    exit 2
  fi
done

echo "running enabled-plugin health gate..."
node "$GATE_JS" --base-url "$BASE_URL"
echo "post-cutover plugin health gate passed"
