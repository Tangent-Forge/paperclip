#!/usr/bin/env bash
# Knowledge Ingest Reviewer Module
#
# Two-tier auto-review of files in the TF Brain inbox:
#   Tier 1: Ollama qwen3:4b scores knowledge density 0-100
#   Tier 2: Claude Haiku 4.5 re-reviews borderline (30-70) or sensitive items
#
# Routing:
#   score < 30          → ARCHIVE/low_value/  (with .reason.json)
#   30 ≤ score ≤ 70     → quarantine after Haiku confirms
#   score > 70          → fast-track to quarantine
#   PII / cred / decode / API failure → exceptions/ + Paperclip issue
#
# This module is intentionally a thin wrapper. All decision logic lives in
# tf-brain-ingest/scripts/auto_review.py. Module returns exit 0 always —
# per-file outcomes are reported via stdout NDJSON.

set -uo pipefail

CWD="${JANITOR_CWD:-$(pwd)}"
DRY_RUN="${JANITOR_DRY_RUN:-1}"
VAULT_PATH="${VAULT_PATH:-$CWD}"
INBOX_DIR="${INBOX_DIR:-$VAULT_PATH/00_Inbox}"
INGEST_REPO="${INGEST_REPO:-$HOME/tangent-forge/repos/tf-brain-ingest}"
AUTO_REVIEW="${AUTO_REVIEW:-$INGEST_REPO/scripts/auto_review.py}"

echo "=== Knowledge Ingest Review ==="
echo "Workspace:  $CWD"
echo "Vault:      $VAULT_PATH"
echo "Inbox:      $INBOX_DIR"
echo "Dry-run:    $DRY_RUN"
echo "Auto-review: $AUTO_REVIEW"
echo ""

if [[ ! -d "$INBOX_DIR" ]]; then
  echo "[skip] Inbox directory not found — nothing to review."
  echo "=== Knowledge Ingest Review Complete (no inbox) ==="
  exit 0
fi

if [[ ! -f "$AUTO_REVIEW" ]]; then
  echo "[error] auto_review.py not found at $AUTO_REVIEW"
  echo "[error] Install tf-brain-ingest at \$INGEST_REPO or set AUTO_REVIEW."
  echo "=== Knowledge Ingest Review Complete (helper missing) ==="
  # Surface as exit 0 so the janitor agent stays idle; the missing helper is
  # an install-time issue, not a per-run failure. The error line will show
  # up in the report and operator can act on it.
  exit 0
fi

PY="${PYTHON_BIN:-python3}"
ARGS=(--inbox "$INBOX_DIR" --vault "$VAULT_PATH")
if [[ "$DRY_RUN" == "1" ]]; then
  ARGS+=(--dry-run)
fi

echo "--- Running auto-review ---"
"$PY" "$AUTO_REVIEW" "${ARGS[@]}" || {
  ec=$?
  echo "[warn] auto_review.py exited $ec — review log for details."
}

echo ""
echo "=== Knowledge Ingest Review Complete ==="
exit 0
