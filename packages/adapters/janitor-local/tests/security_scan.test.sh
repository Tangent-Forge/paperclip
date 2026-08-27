#!/usr/bin/env bash
# Test: security_scan.sh exits 0 on a fixture dir with known matches.
#
# Regression test for the prior SIGPIPE failure:
# - Module previously exited 141 (SIGPIPE) after the secret-pattern scan ran.
#   The `echo "$matches" | head -5 | while read` pipeline let `head -5` close
#   the pipe while upstream `echo` was still writing a multi-thousand-line
#   buffer, triggering SIGPIPE that propagated under `pipefail` and aborted
#   the script BEFORE reaching the .env and key-file sections.
# - The wrapper interpreted exit 141 as `adapter_failed`, putting the agent
#   in `status=error`.
# - Fix: `trap '' PIPE` + `{ ...; } || true` wrappers around the head/while
#   and find/while pipelines.
#
# To reliably reproduce the SIGPIPE timing, the fixture writes a LARGE
# number of matches (≥10k lines for the sk- pattern) so grep's output buffer
# is still writing when head -5 closes the pipe.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE="$SCRIPT_DIR/../modules/security_scan.sh"

if [[ ! -f "$MODULE" ]]; then
  echo "FAIL: module not found at $MODULE"
  exit 1
fi

# ---------------------------------------------------------------------------
# Fixture: a throwaway directory with enough secret-like strings to make grep
# produce a large output buffer. Pattern matches the production failure shape
# The generated values are test fixtures, not real credentials.
# ---------------------------------------------------------------------------
FIXTURE="$(mktemp -d)"
STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"
cleanup() {
  rm -rf "$FIXTURE"
  rm -f "$STDOUT_FILE" "$STDERR_FILE"
}
trap cleanup EXIT

mkdir -p "$FIXTURE/src" "$FIXTURE/tests"

# Write 200 files × 50 sk- matches each = 10,000 matches. This buffer size
# reliably reproduces the SIGPIPE timing on the pre-fix script (verified
# locally — pre-fix exits 141, post-fix exits 0).
for i in $(seq 1 200); do
  {
    for j in $(seq 1 50); do
      printf 'api_key_%s_%s = "%s%s_%s_%s"\n' "$i" "$j" 'sk-' '1234567890abcdefghij' "$i" "$j"
    done
  } > "$FIXTURE/src/file_${i}.py"
done

# Also include single-match entries for the other pattern families so we
# exercise multiple pattern iterations of the loop.
{
  printf 'SK_ANT = "%s%s"\n' 'sk-' 'ant-api03-abcdefghijklmnopqrstuvwxyz'
  printf 'AIZA   = "%s%s"\n' 'AI' 'zaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567'
  printf 'AKIA   = "%s%s"\n' 'AK' 'IA1234567890ABCDEF'
  printf 'GUMRD  = "%s%s"\n' 'gum' 'road_fake_test_token_1234567890'
} > "$FIXTURE/tests/other_patterns.py"

# Run the module against the fixture.
set +e
JANITOR_CWD="$FIXTURE" bash "$MODULE" > "$STDOUT_FILE" 2> "$STDERR_FILE"
RC=$?
set -e

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
assert_ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
assert_fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# 1. Exit code must be 0 (the central regression criterion).
if [[ "$RC" == "0" ]]; then
  assert_ok "exit code is 0 (was $RC)"
else
  assert_fail "exit code is $RC, expected 0"
fi

# 2. Exit code must NOT be 141 (SIGPIPE — the original bug signature).
if [[ "$RC" != "141" ]]; then
  assert_ok "exit code is not 141 / SIGPIPE"
else
  assert_fail "exit code is 141 — SIGPIPE regression"
fi

# 3. The report must record all generated credential classes without printing
# the regex or matching values themselves.
MATCH_COUNT=$(grep -c '\[MATCH\] Credential pattern detected' "$STDOUT_FILE" || true)
if [[ "$MATCH_COUNT" -ge 5 ]]; then
  assert_ok "report records all generated credential classes"
else
  assert_fail "report recorded only $MATCH_COUNT credential classes"
fi

# 4. The scan must reach the .env-files section AFTER the pattern scan.
#    (The original bug killed the script before this section ran.)
if grep -q '\.env files NOT in \.gitignore' "$STDOUT_FILE"; then
  assert_ok ".env files section was reached"
else
  assert_fail ".env files section was NOT reached (script truncated mid-stream)"
fi

# 5. The scan must reach the key-files section.
if grep -q 'World-readable private key files' "$STDOUT_FILE"; then
  assert_ok "key-files section was reached"
else
  assert_fail "key-files section was NOT reached (script truncated mid-stream)"
fi

# 6. Tail line confirms the scan ran to completion.
if grep -q 'Security Scan Complete' "$STDOUT_FILE"; then
  assert_ok "scan ran to completion"
else
  assert_fail "scan did not reach 'Security Scan Complete' line"
fi

# 7. Matching values must never be copied to scanner output.
if grep -q 'api_key_' "$STDOUT_FILE"; then
  assert_fail "scanner output contains a matching credential line"
else
  assert_ok "scanner output contains file names only"
fi

# 8. Diagnostic check on stderr for real errors.
if grep -qiE 'permission denied|no such file|command not found' "$STDERR_FILE"; then
  echo "  NOTE: stderr contains diagnostic content:"
  sed 's/^/    /' < "$STDERR_FILE"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS assertions passed."
  exit 0
else
  echo "$FAIL of $((PASS+FAIL)) assertions FAILED."
  echo ""
  echo "--- stdout from module (tail) ---"
  tail -20 "$STDOUT_FILE" | sed 's/^/  /'
  echo "--- stderr from module ---"
  sed 's/^/  /' < "$STDERR_FILE"
  exit 1
fi
