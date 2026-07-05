---
type: concept
title: Latest
ingested_via: put_page
ingested_at: '2026-06-21T03:37:22.962Z'
source_kind: put_page
---

# System Health — 20260621T033711Z

Verdict: **RED**
Host: mac-hub
Generated: 20260621T033711Z

\`\`\`json
{
  "verdict": "RED",
  "exit": 2,
  "generated_at": "2026-06-21T03:37:11Z",
  "checks": [
    {
      "id": "H1",
      "state": "pass",
      "detail": "hub reachable at /Users/tangentforge/tangent-forge/repos/agent-systems-hub"
    },
    {
      "id": "H2",
      "state": "pass",
      "detail": "runtime mirror has required set"
    },
    {
      "id": "H3",
      "state": "fail",
      "detail": "provisioning selftest FAILED:   7/8 checks passed"
    },
    {
      "id": "H4",
      "state": "warn",
      "detail": "1 open high: ['TFB-002']"
    },
    {
      "id": "H5",
      "state": "pass",
      "detail": "3 live agent(s); newest 0h ago"
    },
    {
      "id": "H6",
      "state": "pass",
      "detail": "GBrain reachable (identity ok)"
    },
    {
      "id": "H7",
      "state": "pass",
      "detail": "bootstrap ~48 tokens (<=300)"
    },
    {
      "id": "H8",
      "state": "pass",
      "detail": "daily check ran 0h ago on always-on hub (mac-hub)"
    },
    {
      "id": "H9",
      "state": "pass",
      "detail": "origin/main, canonical repo, and runtime mirror agree on 5e430bb8ec7b"
    },
    {
      "id": "H10",
      "state": "warn",
      "detail": "connector-health-latest.json missing \u2014 run connector_health_matrix.py"
    }
  ],
  "host": "mac-hub"
}
\`\`\`
