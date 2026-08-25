import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, integer, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { deliveryRouteContracts } from "./delivery_route_contracts.js";

// Full state vocabulary for the delivery pipeline this row tracks:
//   candidate_verified → publication_authorized → publishing → pr_opened
//                      ↘ publication_blocked (retryable)     ↘ publish_failed (retryable)
//   → merge_authorized → observe_deploy → live_verified
//   → controlled_activation_authorized → accepted
// This service version (see server/src/services/delivery-controller.ts) only
// ever writes the first six states — candidate_verified,
// publication_authorized, publication_blocked, publishing, publish_failed,
// pr_opened. The later states exist in the column's domain so this table
// never needs a migration to grow into the full pipeline, but nothing here
// drives them yet; there is deliberately no service method that can move a
// row past pr_opened. Enforced by a DB-level CHECK constraint below (not
// merely the application layer) — a value outside this list can never be
// written to `state` by any means, including a raw SQL statement that
// bypasses the service entirely.
export const DELIVERY_CANDIDATE_STATES = [
  "candidate_verified",
  "publication_authorized",
  "publication_blocked",
  // The publish claim/lease state: set atomically by claimForPublish() the
  // moment exactly one publisher has committed to acting on this candidate.
  // No second claim can succeed while a candidate is here — see
  // claimForPublish()'s own comment for the mechanism (a conditional UPDATE
  // guarded by the prior state, serialized further by a row lock on the
  // route contract).
  "publishing",
  "publish_failed",
  "pr_opened",
  "merge_authorized",
  "observe_deploy",
  "live_verified",
  "controlled_activation_authorized",
  "accepted",
] as const;

export const deliveryCandidates = pgTable(
  "delivery_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    // Full 40-hex-character git SHA — validated at the service layer, not
    // just accepted as any string. "Exact SHA" is the whole point of this
    // table; a short/ambiguous ref defeats it.
    sha: text("sha").notNull(),
    // The ORIGINAL local filesystem path submitted with this candidate —
    // provenance/audit only. Never read again after submission to locate the
    // commit for publishing; see sourceArtifactPath. Not relied on to still
    // exist, still be a git repo, or still contain this commit by the time a
    // publish is attempted — a caller-supplied worktree path is exactly the
    // thing this schema stopped trusting for that purpose.
    sourceWorktreePath: text("source_worktree_path").notNull(),
    // The server-owned, immutable copy of the commit — a bare git repository
    // this process created once, at submission time, by fetching `sha` out
    // of sourceWorktreePath. Nothing ever writes to it again afterward. This
    // is what pushExactSha's localRepoDir actually points at for every
    // publish/reconciliation attempt, however much later that turns out to
    // be — see deliverySourceArtifact.ts's captureArtifact() for how it's
    // created and verified, and submitCandidate()'s use of it.
    sourceArtifactPath: text("source_artifact_path").notNull(),
    sourceArtifactCapturedAt: timestamp("source_artifact_captured_at", { withTimezone: true }).notNull(),
    // The evidence a candidate is admitted with — test/typecheck results,
    // counts, timestamps. Required non-empty at submission; see
    // submitCandidate()'s validation.
    validationReceipt: jsonb("validation_receipt").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull().default("candidate_verified"),
    blockedReason: text("blocked_reason"),
    routeContractId: uuid("route_contract_id").references(() => deliveryRouteContracts.id),
    // Publish claim/lease — see claimForPublish() and reconcileExpiredLease()
    // in the service. Set on every entry into (or reclaim of) "publishing";
    // never meaningful in any other state.
    leaseAttemptId: uuid("lease_attempt_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    prUrl: text("pr_url"),
    prNumber: integer("pr_number"),
    remoteBranchVerifiedAt: timestamp("remote_branch_verified_at", { withTimezone: true }),
    prVerifiedAt: timestamp("pr_verified_at", { withTimezone: true }),
    // Bounded automatic retry bookkeeping. failureCount never resets; it is
    // the total number of publish_failed landings this candidate has ever
    // had, compared against its route contract's autoRetryLimit by
    // listRetryableFailedCandidateIds() (delivery-controller.ts) — once the
    // count reaches the limit, the worker stops touching this candidate and
    // it stays a human's problem via /publish, same as any permanent
    // failure. failureClassification distinguishes "worth auto-retrying"
    // (transient — network/rate-limit/5xx) from everything else, which
    // defaults to permanent (see classifyPublishFailure()) — an
    // unrecognized failure shape is never assumed safe to retry
    // unattended. nextRetryEarliestAt is the exponential-backoff floor the
    // worker must respect before attempting again.
    failureCount: integer("failure_count").notNull().default(0),
    failureClassification: text("failure_classification"), // transient | permanent | null
    nextRetryEarliestAt: timestamp("next_retry_earliest_at", { withTimezone: true }),
    submittedByActor: text("submitted_by_actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One candidate row per exact commit, ever — the same SHA can't be
    // registered twice under two different (and possibly contradictory)
    // states.
    repoShaUq: uniqueIndex("delivery_candidates_repo_sha_uq").on(table.repo, table.sha),
    stateIdx: index("delivery_candidates_state_idx").on(table.state),
    // sql.raw(), not sql`${...}` interpolation: a CHECK constraint is DDL,
    // not a parameterized query — interpolating these as bind placeholders
    // ($1, $2, ...) produces invalid DDL ("there is no parameter $1"). Safe
    // here because every value is a hardcoded literal from this file's own
    // DELIVERY_CANDIDATE_STATES constant, never external input.
    stateVocabularyCheck: check(
      "delivery_candidates_state_check",
      sql`${table.state} in (${sql.raw(DELIVERY_CANDIDATE_STATES.map((s) => `'${s}'`).join(", "))})`,
    ),
    // Fixed 2-value literal vocabulary — no interpolation needed, still
    // written as a plain SQL fragment (not sql.raw) since there is nothing
    // dynamic here to worry about being turned into a bind placeholder.
    failureClassificationVocabularyCheck: check(
      "delivery_candidates_failure_classification_check",
      sql`${table.failureClassification} is null or ${table.failureClassification} in ('transient', 'permanent')`,
    ),
  }),
);
