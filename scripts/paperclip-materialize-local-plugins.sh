#!/usr/bin/env bash
# Materialize local-path plugins into the managed plugin directory and reinstall
# through the Paperclip API so packagePath no longer points at ephemeral pins.
#
# Usage:
#   paperclip-materialize-local-plugins.sh [base_url] [pluginKey...]
#
# If no pluginKey args are given, every installed plugin with a packagePath is
# reinstalled durable from that path (when the path still exists).
set -euo pipefail

BASE_URL="${1:-${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}}"
shift || true
BASE_URL="${BASE_URL%/}"

LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
curl -fsS -m 20 "$BASE_URL/api/plugins" >"$LIST"

mapfile -t TARGETS < <(python3 - "$LIST" "$@" <<'PY'
import json, os, sys
raw = json.load(open(sys.argv[1]))
wanted = set(sys.argv[2:])
plugins = raw if isinstance(raw, list) else raw.get("plugins") or raw.get("items") or []
for p in plugins:
    key = p.get("pluginKey") or ""
    status = (p.get("status") or "").lower()
    path = p.get("packagePath")
    if status == "uninstalled":
        continue
    if wanted and key not in wanted and p.get("id") not in wanted:
        continue
    if not path or not os.path.isdir(path):
        print(f"skip {key}: packagePath missing or not a dir: {path}", file=sys.stderr)
        continue
    # already managed?
    if "/.paperclip/plugins/managed/" in path.replace("\\", "/"):
        print(f"skip {key}: already managed at {path}", file=sys.stderr)
        continue
    print(f"{p.get('id')}\t{key}\t{path}")
PY
)

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "No plugins needed materialization."
  exit 0
fi

for row in "${TARGETS[@]}"; do
  id="${row%%$'\t'*}"
  rest="${row#*$'\t'}"
  key="${rest%%$'\t'*}"
  src="${rest#*$'\t'}"
  echo "==> Materializing $key from $src"
  # Soft uninstall keeps config/row; reinstall with durable=true rewrites packagePath.
  code=$(curl -sS -o /tmp/pc-uninst.json -w "%{http_code}" -X POST "$BASE_URL/api/plugins/$id/uninstall" || true)
  echo "uninstall HTTP $code"
  code=$(curl -sS -o /tmp/pc-inst.json -w "%{http_code}" -X POST "$BASE_URL/api/plugins/install" \
    -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"packageName":sys.argv[1],"isLocalPath":True,"durable":True}))' "$src")")
  echo "install HTTP $code"
  python3 - <<'PY'
import json
d=json.load(open('/tmp/pc-inst.json'))
print('installed', d.get('pluginKey'), d.get('status'), d.get('packagePath'))
if d.get('status') == 'error' or d.get('error'):
    raise SystemExit(f"install failed: {d}")
PY
done

echo "==> Running enabled-plugin health gate"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/paperclip-enabled-plugins-health-gate.sh" "$BASE_URL"
