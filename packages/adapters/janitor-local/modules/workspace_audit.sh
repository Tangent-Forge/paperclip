#!/usr/bin/env bash
# Workspace Audit Module
# Ported from: TANGENT_FORGE/tools/dev-audit-agent/modules/dev_workspace.ps1
# Scans git repos, VS Code workspace config, and Docker presence.

set -euo pipefail
CWD="${JANITOR_CWD:-$(pwd)}"

echo "=== Workspace Audit ==="
echo "Root: $CWD"
echo ""

echo "--- Git Repositories ---"
find "$CWD" -maxdepth 4 -name ".git" -type d 2>/dev/null | while read -r gitdir; do
  repo=$(dirname "$gitdir")
  branch=$(git -C "$repo" branch --show-current 2>/dev/null || echo "unknown")
  status=$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  remote=$(git -C "$repo" remote get-url origin 2>/dev/null || echo "no remote")
  echo "  $repo"
  echo "    branch: $branch | dirty files: $status | remote: $remote"
done

echo ""
echo "--- node_modules directories ---"
find "$CWD" -maxdepth 5 -name "node_modules" -type d 2>/dev/null | while read -r nm; do
  size=$(du -sh "$nm" 2>/dev/null | cut -f1)
  echo "  $nm ($size)"
done

echo ""
echo "--- .env files (potential secrets) ---"
find "$CWD" -maxdepth 5 -name ".env*" -type f 2>/dev/null | grep -v ".env.example" | while read -r f; do
  echo "  $f"
done

echo ""
echo "--- Docker presence ---"
if command -v docker &>/dev/null; then
  echo "  docker: $(docker --version 2>/dev/null)"
  echo "  running containers: $(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
else
  echo "  docker: not found"
fi

echo ""
echo "--- VS Code workspace files ---"
find "$CWD" -maxdepth 3 -name "*.code-workspace" -o -name ".vscode" -type d 2>/dev/null | head -20 | while read -r f; do
  echo "  $f"
done

echo ""
echo "=== Workspace Audit Complete ==="
