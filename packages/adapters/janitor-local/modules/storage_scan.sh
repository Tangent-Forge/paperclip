#!/usr/bin/env bash
# Storage Cleanup Scan Module
# Ported from: TANGENT_FORGE/tools/dev-audit-agent/modules/storage_cleanup.ps1
# Flags large files, old build artifacts, stale logs, and __pycache__ dirs.

set -euo pipefail
CWD="${JANITOR_CWD:-$(pwd)}"
MAX_AGE="${JANITOR_MAX_AGE_DAYS:-90}"
DRY_RUN="${JANITOR_DRY_RUN:-1}"

echo "=== Storage Scan ==="
echo "Root: $CWD | Max age: ${MAX_AGE} days | Dry-run: $DRY_RUN"
echo ""

echo "--- Large files (>50MB) ---"
{ find "$CWD" -maxdepth 8 -type f -size +50M 2>/dev/null \
  ! -path "*/node_modules/.cache/*" \
  ! -path "*/.git/objects/*" \
  | while read -r f; do
    size=$(du -sh "$f" 2>/dev/null | cut -f1)
    echo "  $size  $f"
  done; } || true

echo ""
echo "--- Build artifact dirs ---"
for pattern in "dist" "build" ".next" "out" "__pycache__" ".pytest_cache" ".mypy_cache" ".ruff_cache"; do
  { find "$CWD" -maxdepth 6 -type d -name "$pattern" 2>/dev/null | while read -r d; do
    size=$(du -sh "$d" 2>/dev/null | cut -f1)
    echo "  [$pattern] $size  $d"
  done; } || true
done

echo ""
echo "--- Log files older than ${MAX_AGE} days ---"
{ find "$CWD" -maxdepth 6 -name "*.log" -type f -mtime "+${MAX_AGE}" 2>/dev/null | while read -r f; do
  size=$(du -sh "$f" 2>/dev/null | cut -f1)
  echo "  $size  $f"
done; } || true

echo ""
echo "--- Stale .zip/.tar.gz archives ---"
{ find "$CWD" -maxdepth 5 \( -name "*.zip" -o -name "*.tar.gz" -o -name "*.tgz" \) -type f 2>/dev/null | while read -r f; do
  size=$(du -sh "$f" 2>/dev/null | cut -f1)
  mtime=$(stat -c "%y" "$f" 2>/dev/null | cut -d' ' -f1)
  echo "  $size  $f  (modified: $mtime)"
done; } || true

echo ""
if [[ "$DRY_RUN" == "0" ]]; then
  echo "--- ACTIVE MODE: No auto-delete implemented. Use approval gates. ---"
else
  echo "--- DRY RUN: No files were modified. ---"
fi

echo "=== Storage Scan Complete ==="
