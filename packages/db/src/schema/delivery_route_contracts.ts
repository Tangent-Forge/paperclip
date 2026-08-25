import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, integer, index, check } from "drizzle-orm/pg-core";

export const DELIVERY_ROUTE_CONTRACT_STATUSES = ["active", "revoked"] as const;

// Bounds enforced at the DB layer (CHECK constraints below) — independent
// of, and in addition to, the service layer's own validation in
// createRouteContract(). A route contract authorizes UNATTENDED external
// action (pushes/PRs), so "bounded" retry policy means an actual ceiling
// exists somewhere no application code can bypass, not just a convention.
export const MAX_AUTO_RETRY_LIMIT = 10;
export const MAX_RETRY_BACKOFF_SECONDS = 86400; // 24h — matches computeNextRetryEarliestAt's own cap in the service

// A standing, human-authorized rule: "candidates matching (repo, branch, base,
// action) may be published under these bounds." This is the actual authority
// boundary for the delivery controller's publisher — it exists so publication
// can run under a bounded rule instead of a fresh chat approval every time,
// while the rule itself can only be created or revoked by a human
// (authorizedByUserId / revokedByUserId are never filled by an agent/system
// actor — the service layer, not this schema, enforces that; documented here
// as the load-bearing invariant).
//
// contentHash anchors the contract's terms against out-of-band tampering
// (e.g. a raw SQL UPDATE bypassing the creation service): it's a sha256 of
// the canonical JSON of {repo, branchPattern, baseBranch, action,
// constraints}, computed at creation and re-verified at every evaluation.
// A mismatch means the row was altered outside the service and the contract
// is treated as invalid, not silently trusted.
export const deliveryRouteContracts = pgTable(
  "delivery_route_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repo: text("repo").notNull(),
    // v1: exact branch match only, despite the "pattern" name (kept so a
    // future prefix/glob match doesn't need a column rename) — see
    // matchesRouteContract() in the service, which does plain equality.
    branchPattern: text("branch_pattern").notNull(),
    baseBranch: text("base_branch").notNull(),
    // v1 only ever evaluates action = "publish" (push + open one PR). Stored
    // as free text, not a DB enum, so later actions (merge/deploy/activate)
    // can register their own contracts without a migration — but nothing in
    // this version's service will act on any action other than "publish".
    action: text("action").notNull(),
    status: text("status").notNull().default("active"), // active | revoked
    // Bounds this contract permits — e.g. { requiredEvidenceKeys: [...],
    // maxDiffFiles }. Evaluated against the candidate's validationReceipt at
    // authorization time; see evaluatePublicationAuthorization().
    constraints: jsonb("constraints").$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    // Bounded automatic retry policy for candidates that land in
    // publish_failed under THIS contract. Both default to the safest
    // possible value: autoRetryLimit 0 means "no automatic retry at all" —
    // an admin must explicitly raise it to opt a route into unattended
    // retry of transient failures. See listRetryableFailedCandidateIds()
    // and runPublishExecution()'s classifyPublishFailure() in the service.
    autoRetryLimit: integer("auto_retry_limit").notNull().default(0),
    retryBackoffSeconds: integer("retry_backoff_seconds").notNull().default(60),
    // contentHash below covers these two columns, not just repo/branch/
    // action/constraints — a raw SQL UPDATE raising autoRetryLimit (the
    // exact "authorizes additional unattended external attempts without
    // going through createRouteContract" attack this exists to close) fails
    // contractIsIntact()'s recompute-and-compare the next time this
    // contract is evaluated or claimed against, same as tampering with the
    // repo or action would.
    authorizedByUserId: text("authorized_by_user_id").notNull(),
    revokedByUserId: text("revoked_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("delivery_route_contracts_lookup_idx").on(
      table.repo,
      table.branchPattern,
      table.baseBranch,
      table.action,
      table.status,
    ),
    // sql.raw(), not sql`${...}` interpolation — see delivery_candidates.ts's
    // stateVocabularyCheck for why (DDL, not a parameterized query). The
    // same rule applies to NUMBER literals, not just strings — any value
    // interpolated via sql`${...}` becomes a bind placeholder ($1), which a
    // CHECK constraint (DDL) cannot use; sql.raw(String(n)) is required.
    statusVocabularyCheck: check(
      "delivery_route_contracts_status_check",
      sql`${table.status} in (${sql.raw(DELIVERY_ROUTE_CONTRACT_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
    autoRetryLimitBoundsCheck: check(
      "delivery_route_contracts_auto_retry_limit_check",
      sql`${table.autoRetryLimit} >= 0 and ${table.autoRetryLimit} <= ${sql.raw(String(MAX_AUTO_RETRY_LIMIT))}`,
    ),
    retryBackoffSecondsBoundsCheck: check(
      "delivery_route_contracts_retry_backoff_seconds_check",
      sql`${table.retryBackoffSeconds} > 0 and ${table.retryBackoffSeconds} <= ${sql.raw(String(MAX_RETRY_BACKOFF_SECONDS))}`,
    ),
  }),
);
