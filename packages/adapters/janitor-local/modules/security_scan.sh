#!/usr/bin/env bash
# Security Scanner Module
# Ported from: TANGENT_FORGE/tools/dev-audit-agent/modules/security_compliance.ps1
#              TANGENT_FORGE/tools/tangent-forge-repo-manager/secrets-registry/
# Detects exposed secrets, world-readable key files, and committed .env files.

set -euo pipefail
# Ignore SIGPIPE (exit 141) from head/pipe truncation inside grep|head|while
# loops (e.g. when `head -5` closes early on large match sets). Real errors
# still fail loudly via the explicit checks inside the loops.
trap '' PIPE
CWD="${JANITOR_CWD:-$(pwd)}"
EXTRA_PATTERNS="${JANITOR_EXTRA_PATTERNS:-}"

echo "=== Security Scan ==="
echo "Root: $CWD"
echo ""

echo "--- Secret pattern scan ---"
PATTERNS=(
  'sk-[a-zA-Z0-9]{20,}'               # OpenAI
  'sk-ant-[a-zA-Z0-9\-]{20,}'         # Anthropic
  'AIza[0-9A-Za-z\-_]{35}'            # Google
  'gsk_[a-zA-Z0-9]{20,}'             # Groq
  'xoxb-[0-9]+-[0-9A-Za-z]+'         # Slack bot token
  'ghp_[a-zA-Z0-9]{36}'              # GitHub personal token
  'ghr_[a-zA-Z0-9]{36}'              # GitHub refresh token
  'AKIA[0-9A-Z]{16}'                  # AWS access key
  'gumroad_[a-zA-Z0-9_]{10,}'        # Gumroad token pattern
)

if [[ -n "$EXTRA_PATTERNS" ]]; then
  IFS=',' read -ra EXTRA <<< "$EXTRA_PATTERNS"
  PATTERNS+=("${EXTRA[@]}")
fi

FOUND_SECRETS=0
for pattern in "${PATTERNS[@]}"; do
  matches=$(grep -rn --include="*.ts" --include="*.js" --include="*.py" \
    --include="*.yaml" --include="*.yml" --include="*.json" --include="*.env" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv --exclude-dir=venv \
    -E "$pattern" "$CWD" 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    echo "  [MATCH] Pattern: $pattern"
    # Wrap the truncated head pipeline in { ...; } || true so SIGPIPE (141)
    # from `head -5` closing the pipe while `echo`/grep upstream is still
    # writing does not propagate through `pipefail` and abort the script.
    { echo "$matches" | head -5 | while read -r line; do echo "    $line"; done; } 2>/dev/null || true
    FOUND_SECRETS=$((FOUND_SECRETS + 1))
  fi
done

if [[ "$FOUND_SECRETS" -eq 0 ]]; then
  echo "  No secret patterns detected."
fi

echo ""
echo "--- .env files NOT in .gitignore ---"
{ find "$CWD" -maxdepth 5 -name ".env" -not -name ".env.example" -type f 2>/dev/null | while read -r envfile; do
  envdir=$(dirname "$envfile")
  repo=$(git -C "$envdir" rev-parse --show-toplevel 2>/dev/null || echo "")
  if [[ -n "$repo" ]]; then
    # Get path relative to repo root for check-ignore to work correctly
    relpath=$(python3 -c "import os; print(os.path.relpath('$envfile', '$repo'))" 2>/dev/null || echo "$envfile")
    gitignored=$(git -C "$repo" check-ignore -q "$relpath" 2>/dev/null && echo "yes" || echo "NO")
    echo "  $envfile  [gitignored: $gitignored]"
  else
    echo "  $envfile  [not in a git repo]"
  fi
done; } || true

echo ""
echo "--- World-readable private key files ---"
{ find "$CWD" -maxdepth 6 \( -name "*.pem" -o -name "*.key" -o -name "id_rsa" -o -name "id_ed25519" \) \
  -type f 2>/dev/null | while read -r f; do
  perms=$(stat -c "%a" "$f" 2>/dev/null)
  echo "  $f  [permissions: $perms]"
  if [[ "$perms" == *"4" || "$perms" == *"6" || "$perms" == *"7" ]]; then
    echo "    ⚠ World-readable or group-readable — recommend chmod 600"
  fi
done; } || true

echo ""
echo "=== Security Scan Complete | Secrets found: $FOUND_SECRETS ==="
