#!/usr/bin/env bash
# Fail a deploy/cutover when any non-uninstalled plugin is in error, or when a
# plugin packagePath points at a missing directory.
#
# Usage:
#   paperclip-enabled-plugins-health-gate.sh [base_url]
#
# Exit 0 = healthy; non-zero = gate failed.
set -euo pipefail

BASE_URL="${1:-${PAPERCLIP_BASE_URL:-http://127.0.0.1:3100}}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsS -m 20 "${BASE_URL%/}/api/plugins" >"$TMP"

python3 - "$TMP" <<'PY'
import json, os, sys
path = sys.argv[1]
raw = json.load(open(path))
plugins = raw if isinstance(raw, list) else raw.get("plugins") or raw.get("items") or []
if not plugins:
    print("health-gate: no plugins registered (ok)")
    raise SystemExit(0)

failures = []
for p in plugins:
    key = p.get("pluginKey") or p.get("id")
    status = (p.get("status") or "").lower()
    package_path = p.get("packagePath")
    last_error = p.get("lastError")
    if status == "uninstalled":
        continue
    if status == "error":
        failures.append(f"{key}: status=error lastError={last_error!r}")
        continue
    if package_path and not os.path.isdir(package_path):
        failures.append(f"{key}: packagePath missing: {package_path}")
        continue
    # ready/installed/disabled are acceptable; error is not.
    if status not in {"ready", "installed", "disabled", "upgrade_pending", "pending_approval"}:
        # unknown statuses are soft-warn only
        print(f"health-gate: note unknown status for {key}: {status}")

if failures:
    print("health-gate: FAILED — enabled/installed plugins unhealthy:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(2)

print(f"health-gate: OK — {len(plugins)} plugin(s) checked against {path}")
PY
