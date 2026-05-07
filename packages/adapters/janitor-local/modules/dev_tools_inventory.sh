#!/usr/bin/env bash
# Dev Tools Inventory Module
# Ported from: TANGENT_FORGE/tools/dev-audit-agent/modules/dev_tools.ps1
# Lists installed dev tool versions and flags known issues.

set -euo pipefail

echo "=== Dev Tools Inventory ==="
echo ""

check_tool() {
  local name="$1"
  local cmd="$2"
  local result
  result=$($cmd 2>/dev/null | head -1 || echo "not found")
  printf "  %-20s %s\n" "$name" "$result"
}

echo "--- Core Tools ---"
check_tool "node"      "node --version"
check_tool "npm"       "npm --version"
check_tool "pnpm"      "pnpm --version"
check_tool "python"    "python3 --version"
check_tool "pip"       "pip3 --version"
check_tool "git"       "git --version"
check_tool "bash"      "bash --version"
check_tool "docker"    "docker --version"
check_tool "docker-compose" "docker compose version"

echo ""
echo "--- AI / LLM Tools ---"
check_tool "claude"    "claude --version"
check_tool "ollama"    "ollama --version"
check_tool "openclaw"  "openclaw --version"

echo ""
echo "--- Rust / Go ---"
check_tool "cargo"     "cargo --version"
check_tool "rustc"     "rustc --version"
check_tool "go"        "go version"

echo ""
echo "--- Linting / Quality ---"
check_tool "ruff"      "ruff --version"
check_tool "eslint"    "eslint --version"
check_tool "tsc"       "tsc --version"

echo ""
echo "--- nvm / rbenv / pyenv ---"
check_tool "nvm"       "bash -c 'source ~/.nvm/nvm.sh && nvm --version'"
check_tool "pyenv"     "pyenv --version"

echo ""
echo "=== Dev Tools Inventory Complete ==="
