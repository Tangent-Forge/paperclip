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
# tf-brain-ingest/scripts/auto_review.py. Failures propagate to the adapter;
# per-file outcomes and approval actions are reported via stdout NDJSON.

set -uo pipefail

CWD="${JANITOR_CWD:-$(pwd)}"
DRY_RUN="${JANITOR_DRY_RUN:-1}"
VAULT_PATH="${VAULT_PATH:-$HOME/tangent-forge/repos/tf-brain}"
INGEST_REPO="${INGEST_REPO:-$HOME/tangent-forge/repos/tf-brain-ingest}"
AUTO_REVIEW="${AUTO_REVIEW:-$INGEST_REPO/scripts/auto_review.py}"
BATCH_LIMIT="${JANITOR_BATCH_LIMIT:-20}"

# This reviewer may only route into governed review/archive lanes. Canonical
# promotion and GBrain import remain operator-only flows outside this module.
export AUTO_PROMOTE=false
export AUTO_GBRAIN_IMPORT=false

echo "=== Knowledge Ingest Review ==="
echo "Workspace:  $CWD"
echo "Vault:      $VAULT_PATH"
echo "Inboxes:    00_Inbox/ and 99_INBOX/ (auto_review.py defaults)"
echo "Dry-run:    $DRY_RUN"
echo "Batch limit: $BATCH_LIMIT"
echo "Auto-review: $AUTO_REVIEW"
echo ""

if [[ ! -f "$AUTO_REVIEW" ]]; then
  echo "[error] auto_review.py not found at $AUTO_REVIEW"
  echo "[error] Install tf-brain-ingest at \$INGEST_REPO or set AUTO_REVIEW."
  echo "=== Knowledge Ingest Review Complete (helper missing) ==="
  exit 1
fi

PY="${PYTHON_BIN:-python3}"
ARGS=(--vault "$VAULT_PATH" --limit "$BATCH_LIMIT")
if [[ -n "${INBOX_DIR:-}" ]]; then
  ARGS+=(--inbox "$INBOX_DIR")
fi
if [[ "$DRY_RUN" == "1" ]]; then
  ARGS+=(--dry-run)
fi

echo "--- Running auto-review ---"
"$PY" "$AUTO_REVIEW" "${ARGS[@]}"
ec=$?
if [[ $ec -ne 0 ]]; then
  echo "[error] auto_review.py exited $ec — review log for details." >&2
  exit "$ec"
fi

echo ""
echo "=== Knowledge Ingest Review Complete ==="
exit 0
