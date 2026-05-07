#!/usr/bin/env bash
# Performance Checks Module
# Ported from: TANGENT_FORGE/tools/dev-audit-agent/modules/performance_checks.ps1
# Reports disk usage, duplicate node_modules, overgrown pnpm stores.

set -euo pipefail
CWD="${JANITOR_CWD:-$(pwd)}"

echo "=== Performance Checks ==="
echo "Root: $CWD"
echo ""

echo "--- Disk usage top-10 (depth 3) ---"
du -sh "$CWD"/*/  2>/dev/null | sort -rh | head -10 | while read -r line; do
  echo "  $line"
done

echo ""
echo "--- Duplicate package.json versions (potential version drift) ---"
find "$CWD" -maxdepth 5 -name "package.json" \
  ! -path "*/node_modules/*" 2>/dev/null | while read -r f; do
  name=$(node -e "try{const p=require('$f');console.log(p.name||'')}catch{}" 2>/dev/null || true)
  ver=$(node -e "try{const p=require('$f');console.log(p.version||'')}catch{}" 2>/dev/null || true)
  if [[ -n "$name" ]]; then
    echo "  $name@$ver  ($f)"
  fi
done | sort | uniq -d -f0

echo ""
echo "--- pnpm store size ---"
PNPM_STORE=$(pnpm store path 2>/dev/null || echo "")
if [[ -n "$PNPM_STORE" && -d "$PNPM_STORE" ]]; then
  size=$(du -sh "$PNPM_STORE" 2>/dev/null | cut -f1)
  echo "  $PNPM_STORE ($size)"
else
  echo "  pnpm store not found"
fi

echo ""
echo "--- Python venv sizes ---"
find "$CWD" -maxdepth 5 \( -name ".venv" -o -name "venv" \) -type d 2>/dev/null | while read -r venv; do
  size=$(du -sh "$venv" 2>/dev/null | cut -f1)
  echo "  $venv ($size)"
done

echo ""
echo "=== Performance Checks Complete ==="
