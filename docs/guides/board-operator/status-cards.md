---
title: Status Cards
summary: Experimental watched-query summaries, refresh policies, costs, and agent authoring
---

Status cards are an experimental company-wide board of persistent summaries. Each card is set up with a single message such as “blocked launch work updated this week — tell me the next decision.” The card's agent (the built-in Summarizer by default, or a per-card override chosen at creation or in settings) compiles that prose into bounded company-search queries, stores the effective query set, and follows the same message as the instructions for every summary it writes. There is no separate summarization prompt to append to or replace.

Enable **Status Cards** from **Instance Settings > Experimental**. When `enableStatusCards` is off, the UI routes and REST API return not found; the feature does not leak into non-enabled instances.

## How updates work

Status cards use SQL change detection before spending model tokens. Paperclip reruns the stored query set on scheduler ticks, compares the result with the previous fingerprint, and marks meaningful additions, removals, or configured field changes as pending.

- **Manual** is the default. Changes make the card stale, but Paperclip never starts an automatic update.
- **Interval** checks every 5, 15, 30, or 60 minutes and only starts an update when the watched result changed.
- **Reactive** waits for the debounce window, then updates after significant changes. The v1 defaults are a 60-second debounce and at most 6 updates per hour.
- **Active hours** batch changes outside the configured window into a later update.
- **Daily token caps** pause automatic work when the card reaches its budget. Manual refresh remains available.

Incremental updates receive the previous summary and only the changed tasks. Paperclip uses a full rebuild after prompt or agent changes, large deltas, periodic drift guards, restore from archive, or an explicit full refresh. Archived cards are disarmed; restoring one leaves it stale and schedules a full refresh rather than silently resuming the old schedule.

## Cost model

The following planning estimates use the v1 Summarizer's haiku-class default model. Provider pricing and the selected model can change the actual cost.

| Work | Estimated usage | Estimated cost |
| --- | --- | --- |
| Incremental update | 1–2k input, about 0.3k output tokens | $0.003–0.006 |
| Busy 15-minute card over 9 hours | about 10–18 change-gated updates | $0.03–0.10/day |
| Reactive worst case | 6 updates/hour for 9 hours | $0.15–0.35/day per card |
| Full rebuild | 5–8k input, about 1k output tokens | $0.01–0.02 |
| Change detection | SQL only | $0 |

Each completed generation is attributed through the normal cost ledger and copied into status-card update history. The board shows today's token and cost totals, per-update history, archived-card lifetime cost, and a create-flow estimate.

## Agent authoring

Agents with `tasks:assign` access can create status cards through the REST API. Agent-authored cards are intentionally hidden from the v1 create UI but appear on the shared company board.

Agent authoring has additional guardrails:

- an agent can manage, refresh, recompile, archive, or delete only cards it authored
- an agent can author at most 20 cards; deleting a card frees a slot
- an agent interest prompt is limited to 4,000 characters
- board-authored prompts retain the general 20,000-character API limit
- all routes remain company-scoped and behind `enableStatusCards`

Creating a card immediately queues the Summarizer compile run. Agents should not call the query or summary write-back endpoints themselves; those endpoints accept only the assigned Summarizer generation issue and run.

See the bundled `status-card-query` skill for a copy-pasteable agent API recipe.

## Evidence-backed operational cards

Operational cards are an additive card kind for infrastructure and workflow observations. They do not compile issue queries and never use interval or reactive refresh. Create them through `POST /api/companies/:companyId/status-cards/operational`, then submit observation-only receipts through `POST /api/companies/:companyId/operational-receipts`.

Paperclip calculates the displayed state on the server:

- **GREEN** — every required receipt is present, fresh, and passing
- **YELLOW** — every required receipt is present and fresh, with at least one degraded result and no failures
- **RED** — every required receipt is present and fresh, with at least one failure
- **GRAY** — one or more required receipts are missing, expired, or future-dated

Missing and stale evidence reaches GRAY without starting a model run. A model may explain a changed YELLOW or RED claim, but its write-back cannot include or alter the state and must match the latest server fingerprint. Successful systemd oneshots are treated as passing while inactive between executions when their last result is `success`.

Every evaluation writes an immutable operational claim with the contributing receipt IDs, observed-at and fresh-until bounds, and receipt provenance. Semantic fingerprints omit receipt IDs and timestamps, so identical healthy observations refresh the evidence trail without repeatedly invoking the Summarizer. Exception issues open only after the configured consecutive-failure threshold, remain deduplicated while active, and resolve only after the configured consecutive-recovery threshold.

Receipt payloads are strict observation contracts. Action fields are rejected, and the ingestion/evaluation path exposes no operation that can restart a service, edit configuration, drain a queue, kill a process, deploy, merge, resolve an approval, or perform recovery. Probes and recovery routines must remain separately named and separately authorized.

Operational cards remain manual/receipt-driven until recurring evaluation is approved separately. Creating or enabling production cards is also a separate operational decision; adding the API and schema does not create any live cards.

## Temporary debug view

The debug tab exposes the interest prompt, compiled query JSON, and a dry-run result while the experimental query compiler is being tuned. It is not intended to become a permanent operator workflow.

Remove the dedicated debug view when all of these are true:

1. compilation failures and effective watched-task counts are diagnosable from the normal card drawer and update history
2. support can inspect the stored query and dry-run through the API without requiring board users to interpret raw JSON
3. status-card QA has no open acceptance or regression case that depends on the debug-only UI

The underlying API may remain available for support tooling even after the temporary tab is removed.
