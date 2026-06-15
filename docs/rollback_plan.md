# Paperclip Rollback Plan

This runbook outlines the exact sequence to safely revert a failed Paperclip update deployment. Use this script-ready guide if Phase 7 live validation fails or metrics breach our error ceiling.

---

## 1. Fast Rollback Command Sequence

If `scripts/guardian-verify.sh --phase 7` fails, immediately trigger:

```bash
# STOP SERVICES
launchctl reload -w /Users/tangentforge/Library/LaunchAgents/com.tangentforge.paperclip.plist 2>/dev/null || launchctl unload -w /Users/tangentforge/Library/LaunchAgents/com.tangentforge.paperclip.plist
launchctl reload -w /Users/tangentforge/Library/LaunchAgents/com.tangentforge.gbrain.plist 2>/dev/null || launchctl unload -w /Users/tangentforge/Library/LaunchAgents/com.tangentforge.gbrain.plist

# ROLL BACK CODE
cd /Users/tangentforge/tangent-forge/repos/paperclip
git checkout master
git reset --hard origin/master

# DOWNGRADE DATABASE MIGRATIONS (DB BACKUP IS CRITICAL)
# Direct restoration from preflight backup is safer than manual SQL down steps for tenant-isolation updates.
dropdb -h localhost -p 5432 -U tangentforge paperclip_prod 2>/dev/null || true
createdb -h localhost -p 5432 -U tangentforge paperclip_prod
pg_restore -h localhost -p 5432 -U tangentforge -d paperclip_prod /Users/tangentforge/paperclip_preflight_backup.dump

# START SERVICES ON MASTER CODE
launchctl load -w /Users/tangentforge/Library/LaunchAgents/com.tangentforge.paperclip.plist
launchctl load -w /Users/tangentforge/Library/LaunchAgents/com.tangentforge.gbrain.plist

# POST-ROLLBACK VERIFICATION
curl -sf http://127.0.0.1:3100/health | jq .
curl -sf http://127.0.0.1:3131/health | jq .
```

---

## 2. In-Depth Operational Runbook

### Pre-Deployment Backup Guard (Manual Step)
Verify database state can be restored with 100% precision. Run this *before* Phase 7:
```bash
pg_dump -h localhost -p 5432 -U tangentforge -F c -b -v -f /Users/tangentforge/paperclip_preflight_backup.dump paperclip_prod
```

### Decoupled Verification Bounds
Since Paperclip is decoupled from GBrain, if Paperclip needs a rollback, **do not touch com.tangentforge.gbrain** unless there is a global port conflict or a DB-level crash (they run on separate PGlite/Postgres targets).

For minor UI-only discrepancies, roll back only the UI static assets proxy by reverting code to master without resetting database schemas.
