import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  deliveryCandidates,
  deliveryRouteContracts,
  deliveryTransitions,
  deliveryWorkerActivations,
  MAX_AUTO_RETRY_LIMIT,
  MAX_RETRY_BACKOFF_SECONDS,
} from "@paperclipai/db";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import type { DeliverySourceArtifactCapturer } from "./delivery-source-artifact.js";

// ---------------------------------------------------------------------------
// The v1 delivery controller: a durable, machine-readable state machine that
// owns the transition a verified source candidate makes toward being
// published, replacing "tests passed; should I push?" narrated in chat with
// a queryable row that has one state, one owner, and one reason it cannot
// advance further right now.
//
// Full pipeline vocabulary (see DELIVERY_CANDIDATE_STATES in the schema):
//   candidate_verified → publication_authorized → publishing → pr_opened
//                      ↘ publication_blocked (retryable)      ↘ publish_failed (retryable)
//   → merge_authorized → observe_deploy → live_verified
//   → controlled_activation_authorized → accepted
//
// This service only implements the first six states (submit, evaluate,
// claim, publish). There is deliberately no function anywhere in this file
// that can move a candidate past pr_opened — merge, deploy, and
// controlled-mode activation stay entirely outside this version's reach, not
// merely "unused."
//
// Every state change goes through exactly one function — transitionCandidate()
// — which is also the actual mechanism behind the publish claim/lease: see
// its own comment and claimForPublish() below.
// ---------------------------------------------------------------------------

export type DeliveryCandidateState =
  | "candidate_verified"
  | "publication_authorized"
  | "publication_blocked"
  | "publishing"
  | "publish_failed"
  | "pr_opened"
  | "merge_authorized"
  | "observe_deploy"
  | "live_verified"
  | "controlled_activation_authorized"
  | "accepted";

// The single source of truth for which transitions are legal. Both
// transitionCandidate() (enforced in code, on every write) and the database's
// own CHECK constraints (enforced on the vocabulary, independent of code) back
// this — a value outside DELIVERY_CANDIDATE_STATES can never be written at
// all, and a value inside it but not reachable from the current state is
// refused here.
const LEGAL_TRANSITIONS: Record<DeliveryCandidateState, readonly DeliveryCandidateState[]> = {
  candidate_verified: ["publication_authorized", "publication_blocked"],
  publication_blocked: ["publication_authorized", "publication_blocked"],
  publication_authorized: ["publishing", "publication_blocked"],
  // publishing -> publishing is not a business-state change; it's the ONE
  // legal self-loop, used exclusively by reconcileExpiredLease() to record a
  // lease reclaim (new attempt id/expiry/owner, same state) as its own
  // transitionCandidate() call rather than a bespoke write path.
  publishing: ["publishing", "pr_opened", "publish_failed"],
  publish_failed: ["publishing", "publication_blocked"],
  pr_opened: [],
  merge_authorized: [],
  observe_deploy: [],
  live_verified: [],
  controlled_activation_authorized: [],
  accepted: [],
};

export interface PullRequestInfo {
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
  state: "open" | "closed" | "merged";
}

// The publisher's ENTIRE surface for touching the outside world. This is the
// architectural half of "never force-push, merge, deploy, restart, or
// activate controlled mode": those operations have no method here to call.
// publish() below cannot invoke what these interfaces don't expose, no
// matter what a future edit to publish() might attempt — the type checker
// enforces the boundary, not just code review discipline.
export interface DeliveryGitClient {
  /** Pushes exactly `sha` to `branch` on `repo`, run from `localRepoDir` — the
   * local checkout that actually contains the commit object. Callers pass
   * the candidate's server-owned sourceArtifactPath here, never the
   * caller-supplied sourceWorktreePath — see delivery_candidates'
   * own comment for why. Never force — a rejected (non-fast-forward) push
   * must throw, not retry with --force. */
  pushExactSha(input: { repo: string; sha: string; branch: string; localRepoDir: string }): Promise<void>;
  /** Read-only. Null means ONLY "this branch genuinely does not exist on
   * the remote" (a clean, successful check that found nothing) — never
   * "the check itself failed". Any failure to actually determine the
   * branch's head (network, auth, an unreachable remote) MUST throw, not
   * return null — runPublishExecution() is what turns that throw into a
   * classified publish_failed + bounded retry; silently mapping it to null
   * would misreport a transient blip as a permanent SHA mismatch. */
  readRemoteBranchHead(input: { repo: string; branch: string }): Promise<string | null>;
}

export interface DeliveryGitHubClient {
  /** Read-only idempotency check, called before every create. */
  findOpenPullRequest(input: { repo: string; branch: string; baseBranch: string }): Promise<PullRequestInfo | null>;
  /** Creates exactly one PR. Callers must have already checked
   * findOpenPullRequest and found none — this method does not check for you. */
  createPullRequest(input: {
    repo: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestInfo>;
  /** Read-only re-fetch, used to verify a create (or a found-existing) PR
   * really exists with the expected head, rather than trusting a prior
   * response object blindly. Null means ONLY a genuine 404 (the PR does
   * not exist) — same contract as readRemoteBranchHead above: any other
   * failure (429, 5xx, connectivity) MUST throw, classified, so
   * runPublishExecution() can route it through bounded retry instead of a
   * permanent-looking null. */
  readPullRequest(input: { repo: string; prNumber: number }): Promise<PullRequestInfo | null>;
}

export interface DeliveryControllerDeps {
  gitClient: DeliveryGitClient;
  githubClient: DeliveryGitHubClient;
  sourceArtifact: DeliverySourceArtifactCapturer;
}

// How long a publish claim is valid before it's eligible for automatic
// reconciliation by another worker tick. Long enough for a real push + PR
// round trip (including retries) to finish under normal conditions; short
// enough that a crashed worker doesn't leave a candidate stuck for long
// before the next tick picks it up — see reconcileExpiredLease().
const PUBLISH_LEASE_DURATION_MS = 5 * 60 * 1000;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

// Retryable-failure classification. Deliberately defaults to "permanent" for
// anything not explicitly recognized as transient — an unfamiliar failure
// shape is never assumed safe for the worker to retry unattended; a false
// "permanent" just means a human looks at it via /publish, while a false
// "transient" would mean silently hammering a route that's actually broken.
// Recognizes: HTTP status codes that mean "try again later" (408 timeout,
// 429 rate-limited, 5xx server-side), and the handful of Node network errno
// codes a real git/GitHub client throws for a dropped connection.
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);

export type PublishFailureClassification = "transient" | "permanent";

// Ground-truth escape hatch: a real adapter (RealGitClient, RealGitHubClient
// — see delivery-publisher-adapters.ts) knows things this function cannot
// reconstruct from a generic Error/HttpError alone — git's stderr text, a
// GitHub response's Retry-After header, whether a fetch() failure was a
// connectivity problem vs. an HTTP error response. Adapters call this to
// stamp their OWN classification onto the error they throw;
// classifyPublishFailure() below checks for that stamp FIRST, before
// falling back to its own generic heuristics. This is what stops real
// adapters from collapsing distinguishable failures into one shape and
// losing the signal before it ever reaches classifyPublishFailure().
export function markPublishFailureClassification<E extends Error>(error: E, classification: PublishFailureClassification): E {
  return Object.assign(error, { publishFailureClassification: classification });
}

export function classifyPublishFailure(error: unknown): PublishFailureClassification {
  const marked = (error as { publishFailureClassification?: unknown } | null)?.publishFailureClassification;
  if (marked === "transient" || marked === "permanent") return marked;
  if (error instanceof HttpError) {
    return TRANSIENT_HTTP_STATUSES.has(error.status) ? "transient" : "permanent";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) {
    return "transient";
  }
  return "permanent";
}

// Exponential backoff off the route contract's own retryBackoffSeconds,
// doubling per failure and capped at MAX_RETRY_BACKOFF_SECONDS (imported
// from @paperclipai/db — the SAME constant the DB-level CHECK constraint on
// delivery_route_contracts.retry_backoff_seconds enforces, so there is one
// source of truth for this bound, not two numbers that could drift).
// failureCount is the count AFTER this failure (i.e. >= 1) — the first
// failure waits one full backoff interval, not zero.
function computeNextRetryEarliestAt(failureCount: number, backoffSeconds: number): Date {
  const seconds = Math.min(backoffSeconds * 2 ** Math.max(failureCount - 1, 0), MAX_RETRY_BACKOFF_SECONDS);
  return new Date(Date.now() + seconds * 1000);
}

function assertValidSha(sha: string) {
  if (!SHA_PATTERN.test(sha)) {
    throw badRequest(`Not an exact 40-character git SHA: ${JSON.stringify(sha)}`);
  }
}

function assertNonEmpty(value: string, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${field} must be a non-empty string`);
  }
}

// Deterministic serialization so contentHash is stable regardless of key
// insertion order — object key order must never change whether a contract's
// hash matches.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function computeRouteContractContentHash(input: {
  repo: string;
  branchPattern: string;
  baseBranch: string;
  action: string;
  constraints: Record<string, unknown>;
  // Included so a raw SQL UPDATE raising either of these — authorizing
  // additional unattended external attempts without going through
  // createRouteContract() at all — fails contractIsIntact()'s recompute-
  // and-compare the same way tampering with repo/branch/action would.
  autoRetryLimit: number;
  retryBackoffSeconds: number;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export interface NextAction {
  owner: "system" | "human" | "none";
  action: string;
}

// The "one state, one owner, one next action, one reason it cannot advance"
// requirement, made a pure function of the row itself rather than something
// a caller has to reconstruct from narrative.
export function describeNextAction(candidate: {
  state: string;
  blockedReason: string | null;
  leaseExpiresAt?: Date | string | null;
}): NextAction {
  switch (candidate.state as DeliveryCandidateState) {
    case "candidate_verified":
      return { owner: "system", action: "evaluate publication authorization against the matching route contract" };
    case "publication_blocked":
      return { owner: "human", action: candidate.blockedReason ?? "resolve the route-contract block, then re-evaluate" };
    case "publication_authorized":
      return { owner: "system", action: "publisher may claim this candidate and push the exact SHA / open one PR" };
    case "publishing": {
      const expiresAt = candidate.leaseExpiresAt ? new Date(candidate.leaseExpiresAt) : null;
      const expired = expiresAt !== null && expiresAt.getTime() < Date.now();
      return expired
        ? { owner: "system", action: "publish lease expired — eligible for automatic reconciliation on the next worker tick" }
        : { owner: "system", action: "publish claimed and in progress — push and PR creation underway" };
    }
    case "publish_failed":
      return { owner: "human", action: candidate.blockedReason ?? "resolve the publish failure, then retry publish" };
    case "pr_opened":
      return { owner: "human", action: "independent review of the opened PR — not automated by this controller version" };
    case "accepted":
      return { owner: "none", action: "terminal — live-verified and accepted" };
    default:
      // merge_authorized | observe_deploy | live_verified | controlled_activation_authorized
      return { owner: "human", action: "not yet automated by this controller version" };
  }
}

export function deliveryControllerService(db: Db, deps: DeliveryControllerDeps) {
  async function recordTransition(
    tx: Db,
    input: {
      candidateId: string;
      fromState: string | null;
      toState: string;
      actor: string;
      reason?: string | null;
      evidence?: Record<string, unknown> | null;
    },
  ) {
    await tx.insert(deliveryTransitions).values({
      candidateId: input.candidateId,
      fromState: input.fromState,
      toState: input.toState,
      actor: input.actor,
      reason: input.reason ?? null,
      evidence: input.evidence ?? null,
    });
  }

  // THE single place every state change goes through. Two things happen
  // atomically here:
  //   1. A conditional UPDATE guarded by `state = candidate.state` (the
  //      caller's own already-observed current state) — if a concurrent
  //      transition on the SAME row won this race first, this UPDATE
  //      matches zero rows and this function throws conflict(), rolling the
  //      caller's transaction back. This conditional UPDATE is not an
  //      incidental detail — it IS the concurrency-safety mechanism behind
  //      claimForPublish()'s "exactly one publisher can act" guarantee, the
  //      same way execution-queue.ts's `SELECT ... FOR UPDATE SKIP LOCKED`
  //      was the mechanism there, just via optimistic (compare-and-swap)
  //      rather than pessimistic locking — appropriate here because the
  //      thing being raced over is a single row's own state column, not a
  //      selection among many candidate rows.
  //   2. An append-only delivery_transitions row recording exactly what
  //      happened, including the reason/evidence — never skipped, never
  //      optional, so "every mutation logs activity" is a property of this
  //      one function rather than something each caller has to remember.
  //
  // Illegal transitions (not present in LEGAL_TRANSITIONS) are refused
  // before touching the database at all.
  async function transitionCandidate(
    tx: Db,
    candidate: { id: string; state: string },
    toState: DeliveryCandidateState,
    actor: string,
    opts: {
      patch?: Record<string, unknown>;
      reason?: string | null;
      evidence?: Record<string, unknown> | null;
      // ANDed into the guard alongside `state = fromState` — used by
      // reconcileExpiredLease() to additionally require the specific
      // (attemptId, expiry) it observed, so two concurrent reconciliation
      // attempts can't both "win" the same expired lease.
      extraGuard?: SQL;
    } = {},
  ): Promise<typeof deliveryCandidates.$inferSelect> {
    const fromState = candidate.state as DeliveryCandidateState;
    const allowed = LEGAL_TRANSITIONS[fromState] ?? [];
    if (!allowed.includes(toState)) {
      throw conflict(`Illegal transition ${fromState} -> ${toState}`);
    }
    const guard = opts.extraGuard
      ? and(eq(deliveryCandidates.id, candidate.id), eq(deliveryCandidates.state, fromState), opts.extraGuard)
      : and(eq(deliveryCandidates.id, candidate.id), eq(deliveryCandidates.state, fromState));
    const [updated] = await tx
      .update(deliveryCandidates)
      .set({ state: toState, updatedAt: new Date(), ...opts.patch })
      .where(guard)
      .returning();
    if (!updated) {
      throw conflict(
        `Candidate ${candidate.id} is no longer in state "${fromState}" (or failed an additional guard) — a concurrent transition already occurred`,
      );
    }
    await recordTransition(tx, {
      candidateId: candidate.id,
      fromState,
      toState,
      actor,
      reason: opts.reason ?? null,
      evidence: opts.evidence ?? null,
    });
    return updated;
  }

  async function getCandidate(candidateId: string) {
    const [row] = await db.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidateId));
    if (!row) throw notFound(`No delivery candidate ${candidateId}`);
    return row;
  }

  async function listCandidates(filter: { repo?: string; state?: string } = {}) {
    const conditions = [];
    if (filter.repo) conditions.push(eq(deliveryCandidates.repo, filter.repo));
    if (filter.state) conditions.push(eq(deliveryCandidates.state, filter.state));
    const query = db.select().from(deliveryCandidates);
    return conditions.length > 0 ? query.where(and(...conditions)) : query;
  }

  // Worker-facing: what runWorkerTick() (delivery-controller-worker.ts)
  // polls for on every tick. Deliberately publication_authorized ONLY, not
  // publish_failed — a fresh authorization and a retryable failure are
  // different kinds of eligibility with different rules (the latter is
  // bounded by the route contract's autoRetryLimit/backoff — see
  // listRetryableFailedCandidateIds() below, not this function).
  async function listClaimableCandidateIds(): Promise<string[]> {
    const rows = await db
      .select({ id: deliveryCandidates.id })
      .from(deliveryCandidates)
      .where(eq(deliveryCandidates.state, "publication_authorized"));
    return rows.map((r) => r.id);
  }

  async function listExpiredLeaseCandidateIds(): Promise<string[]> {
    const rows = await db
      .select({ id: deliveryCandidates.id })
      .from(deliveryCandidates)
      .where(and(eq(deliveryCandidates.state, "publishing"), lt(deliveryCandidates.leaseExpiresAt, new Date())));
    return rows.map((r) => r.id);
  }

  // The bounded automatic retry surface: publish_failed candidates the
  // worker is ALLOWED to touch again, unattended, without a human first
  // looking at them. A candidate qualifies only if ALL of:
  //   - its own last failure was classified "transient" (see
  //     classifyPublishFailure() — anything else, including an
  //     unrecognized failure shape, is never auto-retried);
  //   - its exponential backoff window (nextRetryEarliestAt) has elapsed;
  //   - its route contract still exists and its failureCount hasn't yet
  //     reached that contract's autoRetryLimit (default 0 — i.e. off by
  //     default; an admin must explicitly raise it per-route).
  // Once any of these fails, the candidate stays publish_failed and
  // reachable only via the human-operated /publish diagnostic path — the
  // same "human escalation after the cap, or after a classified permanent
  // failure" the route contract is supposed to guarantee.
  async function listRetryableFailedCandidateIds(): Promise<string[]> {
    const now = new Date();
    const rows = await db
      .select({
        id: deliveryCandidates.id,
        failureCount: deliveryCandidates.failureCount,
        routeContractId: deliveryCandidates.routeContractId,
        nextRetryEarliestAt: deliveryCandidates.nextRetryEarliestAt,
      })
      .from(deliveryCandidates)
      .where(and(eq(deliveryCandidates.state, "publish_failed"), eq(deliveryCandidates.failureClassification, "transient")));

    const eligible: string[] = [];
    for (const row of rows) {
      if (row.nextRetryEarliestAt && row.nextRetryEarliestAt.getTime() > now.getTime()) continue; // backoff not elapsed
      if (!row.routeContractId) continue; // nothing to evaluate a retry cap against
      const [contract] = await db.select().from(deliveryRouteContracts).where(eq(deliveryRouteContracts.id, row.routeContractId));
      // Full row (not just autoRetryLimit) — contractIsIntact() needs every
      // hashed field. A contract that's revoked, missing, or whose
      // contentHash no longer matches (e.g. a raw SQL UPDATE raising
      // autoRetryLimit outside createRouteContract()) authorizes NOTHING
      // here, independent of claimForPublish()'s own identical check a
      // moment later — this is what stops a tampered retry policy from
      // even being SURFACED as eligible, not just from ultimately acting.
      if (!contract || contract.status !== "active" || !contractIsIntact(contract)) continue;
      if (row.failureCount >= contract.autoRetryLimit) continue; // cap reached — human escalation only
      eligible.push(row.id);
    }
    return eligible;
  }

  async function listTransitions(candidateId: string) {
    return db
      .select()
      .from(deliveryTransitions)
      .where(eq(deliveryTransitions.candidateId, candidateId))
      .orderBy(desc(deliveryTransitions.occurredAt));
  }

  // Idempotent: resubmitting the exact same (repo, sha) returns the existing
  // row untouched rather than erroring or duplicating — the same "safe to
  // retry" property the publisher itself is held to. This is the one place
  // that writes a delivery_candidates row WITHOUT going through
  // transitionCandidate() — there is no prior state to transition FROM, so
  // "route every state change through one function" doesn't apply to
  // genesis; the initial delivery_transitions row (fromState: null) is still
  // written explicitly below, so activity logging stays complete.
  async function submitCandidate(input: {
    repo: string;
    branch: string;
    baseBranch: string;
    sha: string;
    sourceWorktreePath: string;
    validationReceipt: Record<string, unknown>;
    submittedByActor: string;
  }) {
    assertNonEmpty(input.repo, "repo");
    assertNonEmpty(input.branch, "branch");
    assertNonEmpty(input.baseBranch, "baseBranch");
    assertValidSha(input.sha);
    assertNonEmpty(input.sourceWorktreePath, "sourceWorktreePath");
    assertNonEmpty(input.submittedByActor, "submittedByActor");
    if (!input.validationReceipt || Object.keys(input.validationReceipt).length === 0) {
      throw badRequest("validationReceipt must be a non-empty object — a candidate without evidence is not verified");
    }

    // Fast idempotency path — skip the artifact capture below (a real,
    // possibly-slow git subprocess operation) for a resubmission of an
    // already-known (repo, sha).
    const [existing] = await db
      .select()
      .from(deliveryCandidates)
      .where(and(eq(deliveryCandidates.repo, input.repo), eq(deliveryCandidates.sha, input.sha)));
    if (existing) return existing;

    // Validates the local checkout (real repo, commit present, origin
    // matches the declared repo) and captures a server-owned immutable copy
    // — BEFORE any row is written. There is no "candidate_verified but has
    // no real artifact" state; if capture fails, submission fails entirely.
    // Deliberately outside any DB transaction — a slow/failing subprocess
    // must never hold a Postgres transaction open.
    const { artifactPath, capturedAt } = await deps.sourceArtifact.captureArtifact({
      sourceWorktreePath: input.sourceWorktreePath,
      sha: input.sha,
      branch: input.branch,
      repo: input.repo,
    });

    return db.transaction(async (tx) => {
      const scopedTx = tx as unknown as Db;
      // Re-check inside the transaction: a concurrent submission of the
      // exact same (repo, sha) could have won between the fast check above
      // and now. The UNIQUE (repo, sha) index is the real authority here;
      // this just avoids surfacing a raw duplicate-key error in that case.
      const [raced] = await tx
        .select()
        .from(deliveryCandidates)
        .where(and(eq(deliveryCandidates.repo, input.repo), eq(deliveryCandidates.sha, input.sha)));
      if (raced) return raced;

      const [created] = await tx
        .insert(deliveryCandidates)
        .values({
          repo: input.repo,
          branch: input.branch,
          baseBranch: input.baseBranch,
          sha: input.sha,
          sourceWorktreePath: input.sourceWorktreePath,
          sourceArtifactPath: artifactPath,
          sourceArtifactCapturedAt: capturedAt,
          validationReceipt: input.validationReceipt,
          state: "candidate_verified",
          submittedByActor: input.submittedByActor,
        })
        .returning();
      await recordTransition(scopedTx, {
        candidateId: created!.id,
        fromState: null,
        toState: "candidate_verified",
        actor: input.submittedByActor,
        evidence: { validationReceiptKeys: Object.keys(input.validationReceipt), sourceArtifactPath: artifactPath },
      });
      return created!;
    });
  }

  // A standing, human-authorized rule. authorizedByUserId is required and
  // never defaulted — there is no path in this file for an agent/system
  // actor to author its own authority. The HTTP route layer is what actually
  // guarantees a human called this (assertInstanceAdmin) — this service can
  // only refuse an empty/missing identity, which it does.
  async function createRouteContract(input: {
    repo: string;
    branchPattern: string;
    baseBranch: string;
    action: string;
    constraints?: Record<string, unknown>;
    authorizedByUserId: string;
    // Bounded automatic retry policy — both default to the safest value
    // (0 retries / 60s base backoff) if omitted. Deliberately NOT part of
    // contentHash's inputs: they govern worker behavior, not what publish
    // action this contract authorizes, so tightening/loosening a retry
    // policy doesn't require re-authorizing the underlying route.
    autoRetryLimit?: number;
    retryBackoffSeconds?: number;
  }) {
    assertNonEmpty(input.repo, "repo");
    assertNonEmpty(input.branchPattern, "branchPattern");
    assertNonEmpty(input.baseBranch, "baseBranch");
    assertNonEmpty(input.action, "action");
    assertNonEmpty(input.authorizedByUserId, "authorizedByUserId");
    if (
      input.autoRetryLimit !== undefined &&
      (!Number.isInteger(input.autoRetryLimit) || input.autoRetryLimit < 0 || input.autoRetryLimit > MAX_AUTO_RETRY_LIMIT)
    ) {
      throw badRequest(`autoRetryLimit must be an integer between 0 and ${MAX_AUTO_RETRY_LIMIT}`);
    }
    if (
      input.retryBackoffSeconds !== undefined &&
      (!Number.isInteger(input.retryBackoffSeconds) || input.retryBackoffSeconds <= 0 || input.retryBackoffSeconds > MAX_RETRY_BACKOFF_SECONDS)
    ) {
      throw badRequest(`retryBackoffSeconds must be an integer between 1 and ${MAX_RETRY_BACKOFF_SECONDS}`);
    }
    const constraints = input.constraints ?? {};
    // Resolved to their REAL final values (matching the DB column
    // defaults) before hashing — the hash must cover what the contract
    // actually authorizes, not "undefined", regardless of whether the
    // caller passed them explicitly.
    const autoRetryLimit = input.autoRetryLimit ?? 0;
    const retryBackoffSeconds = input.retryBackoffSeconds ?? 60;
    const contentHash = computeRouteContractContentHash({
      repo: input.repo,
      branchPattern: input.branchPattern,
      baseBranch: input.baseBranch,
      action: input.action,
      constraints,
      autoRetryLimit,
      retryBackoffSeconds,
    });
    const [created] = await db
      .insert(deliveryRouteContracts)
      .values({
        repo: input.repo,
        branchPattern: input.branchPattern,
        baseBranch: input.baseBranch,
        action: input.action,
        constraints,
        contentHash,
        authorizedByUserId: input.authorizedByUserId,
        autoRetryLimit,
        retryBackoffSeconds,
      })
      .returning();
    return created!;
  }

  async function revokeRouteContract(contractId: string, revokedByUserId: string) {
    assertNonEmpty(revokedByUserId, "revokedByUserId");
    const [updated] = await db
      .update(deliveryRouteContracts)
      .set({ status: "revoked", revokedByUserId, revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(deliveryRouteContracts.id, contractId))
      .returning();
    if (!updated) throw notFound(`No route contract ${contractId}`);
    return updated;
  }

  // Re-verifies a loaded contract's integrity fresh — recomputes contentHash
  // from its current stored fields and compares. A mismatch means the row
  // was altered outside createRouteContract/revokeRouteContract (e.g. a raw
  // SQL UPDATE), and the contract is treated as invalid, never trusted.
  function contractIsIntact(contract: typeof deliveryRouteContracts.$inferSelect): boolean {
    const recomputed = computeRouteContractContentHash({
      repo: contract.repo,
      branchPattern: contract.branchPattern,
      baseBranch: contract.baseBranch,
      action: contract.action,
      constraints: contract.constraints,
      autoRetryLimit: contract.autoRetryLimit,
      retryBackoffSeconds: contract.retryBackoffSeconds,
    });
    return recomputed === contract.contentHash;
  }

  function evaluateConstraints(
    constraints: Record<string, unknown>,
    validationReceipt: Record<string, unknown>,
  ): string | null {
    const requiredKeys = constraints.requiredEvidenceKeys;
    if (Array.isArray(requiredKeys)) {
      const missing = requiredKeys.filter(
        (key) => typeof key === "string" && !(key in validationReceipt && validationReceipt[key]),
      );
      if (missing.length > 0) {
        return `route contract requires evidence keys [${missing.join(", ")}], missing from validationReceipt`;
      }
    }
    return null; // no violation
  }

  const EVALUATABLE_STATES: readonly DeliveryCandidateState[] = ["candidate_verified", "publication_blocked"];

  // candidate_verified | publication_blocked → publication_authorized | publication_blocked
  async function evaluatePublicationAuthorization(candidateId: string, actor: string) {
    return db.transaction(async (tx) => {
      const scopedTx = tx as unknown as Db;
      const [candidate] = await tx.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidateId));
      if (!candidate) throw notFound(`No delivery candidate ${candidateId}`);
      if (!EVALUATABLE_STATES.includes(candidate.state as DeliveryCandidateState)) {
        throw conflict(
          `Cannot evaluate publication authorization from state "${candidate.state}" — must be candidate_verified or publication_blocked`,
        );
      }

      const matches = await tx
        .select()
        .from(deliveryRouteContracts)
        .where(
          and(
            eq(deliveryRouteContracts.repo, candidate.repo),
            eq(deliveryRouteContracts.branchPattern, candidate.branch),
            eq(deliveryRouteContracts.baseBranch, candidate.baseBranch),
            eq(deliveryRouteContracts.action, "publish"),
            eq(deliveryRouteContracts.status, "active"),
          ),
        );

      const block = (reason: string) =>
        transitionCandidate(scopedTx, candidate, "publication_blocked", actor, { reason, patch: { blockedReason: reason } });

      if (matches.length === 0) {
        return block(
          `No active route contract authorizes publish for ${candidate.repo}:${candidate.branch}->${candidate.baseBranch}`,
        );
      }
      if (matches.length > 1) {
        // Fail closed on ambiguity rather than silently picking one — an
        // admin data error must not become an implicit choice.
        return block(
          `Ambiguous route contracts: ${matches.length} active contracts match ${candidate.repo}:${candidate.branch}->${candidate.baseBranch}:publish`,
        );
      }
      const contract = matches[0]!;
      if (!contractIsIntact(contract)) {
        return block(`Route contract ${contract.id} failed its integrity check (content hash mismatch) — treated as tampered`);
      }
      const violation = evaluateConstraints(contract.constraints, candidate.validationReceipt);
      if (violation) {
        return block(violation);
      }

      return transitionCandidate(scopedTx, candidate, "publication_authorized", actor, {
        patch: { blockedReason: null, routeContractId: contract.id },
        evidence: { routeContractId: contract.id, contentHash: contract.contentHash },
      });
    });
  }

  const PUBLISHABLE_STATES: readonly DeliveryCandidateState[] = ["publication_authorized", "publish_failed"];

  // The transactional publish claim/lease. Exactly one publisher can move a
  // candidate into "publishing" — the mechanism is transitionCandidate()'s
  // own conditional UPDATE (see its comment), further serialized here by a
  // row lock on the candidate's route contract:
  //
  //   `select ... from delivery_route_contracts where id = ? for update`
  //
  // held for the rest of this transaction. This is what makes "recheck the
  // active contract while claiming it" atomic with the claim itself, and it
  // is also the exact mechanism behind the documented limitation: a
  // concurrent revokeRouteContract() call on the SAME contract blocks on
  // this lock until this transaction commits or rolls back. If the
  // revocation's own UPDATE runs (and commits) BEFORE this SELECT acquires
  // the lock, this claim correctly observes the revoked contract and blocks
  // — "revocation prevents future claims". If this transaction acquires the
  // lock first, the revocation waits until AFTER this claim has already
  // committed to "publishing" — the revocation still succeeds afterward
  // (correctly preventing any FUTURE claim), but it cannot retroactively
  // stop the publish this transaction already committed to. There is no
  // cancellation channel for an in-flight claim in this version — "cannot
  // cancel a claim already executing" is a deliberate v1 limitation, not an
  // oversight; a stuck "publishing" row (e.g. the process crashes mid-Phase-2
  // below) has no automatic recovery path either.
  async function claimForPublish(
    candidateId: string,
    actor: string,
  ): Promise<{ kind: "claimed" | "blocked"; candidate: typeof deliveryCandidates.$inferSelect }> {
    return db.transaction(async (tx) => {
      const scopedTx = tx as unknown as Db;
      const [candidate] = await tx.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidateId));
      if (!candidate) throw notFound(`No delivery candidate ${candidateId}`);
      if (!PUBLISHABLE_STATES.includes(candidate.state as DeliveryCandidateState)) {
        throw conflict(
          `Cannot publish from state "${candidate.state}" — must be publication_authorized or publish_failed`,
        );
      }
      if (!candidate.routeContractId) {
        throw conflict(`Candidate ${candidateId} has no routeContractId despite being in state "${candidate.state}"`);
      }

      await tx.execute(sql`select id from delivery_route_contracts where id = ${candidate.routeContractId} for update`);
      const [contract] = await tx
        .select()
        .from(deliveryRouteContracts)
        .where(eq(deliveryRouteContracts.id, candidate.routeContractId));

      if (!contract || contract.status !== "active" || !contractIsIntact(contract)) {
        const reason = !contract
          ? `Route contract ${candidate.routeContractId} no longer exists`
          : contract.status !== "active"
            ? `Route contract ${contract.id} was revoked before this claim`
            : `Route contract ${contract.id} failed its integrity check before this claim`;
        const blocked = await transitionCandidate(scopedTx, candidate, "publication_blocked", actor, {
          reason,
          patch: { blockedReason: reason },
        });
        return { kind: "blocked", candidate: blocked };
      }

      // The claim itself: a candidate racing another claimForPublish() call
      // for the SAME candidate loses here — transitionCandidate() throws
      // conflict() when its conditional UPDATE affects zero rows, which
      // rolls this whole transaction back. Route layer callers see a 409.
      // Every claim gets a fresh lease (attempt id, expiry, owner) — this is
      // what reconcileExpiredLease() later uses to recover a candidate whose
      // claimant crashed without ever coming back.
      const claimed = await transitionCandidate(scopedTx, candidate, "publishing", actor, {
        patch: {
          blockedReason: null,
          leaseAttemptId: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + PUBLISH_LEASE_DURATION_MS),
          leaseOwner: actor,
        },
        evidence: { routeContractId: contract.id },
      });
      return { kind: "claimed", candidate: claimed };
    });
  }

  // If a concurrent attempt (an original claimant that wasn't actually dead,
  // just slow, racing a reconciler that reclaimed its lease) already
  // finalized this candidate first, both sides did idempotent, read-back-
  // verified work — whichever committed first is a truthful outcome. Adopt
  // it rather than surface a 409 for something that actually resolved
  // correctly.
  async function finalizeOrAdoptConcurrentOutcome(
    candidateId: string,
    attempt: () => Promise<typeof deliveryCandidates.$inferSelect>,
  ): Promise<typeof deliveryCandidates.$inferSelect> {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        return getCandidate(candidateId);
      }
      throw error;
    }
  }

  // The actual push/PR work — network calls that can be slow, so this always
  // runs OUTSIDE any open transaction/lock. Shared by publish() (a fresh
  // claim) and reconcileExpiredLease() (a reclaimed one): both hand this a
  // candidate already in "publishing" and let it decide the outcome. Pushes
  // from candidate.sourceArtifactPath — the server-owned immutable copy, not
  // the original sourceWorktreePath, which nothing here trusts to still
  // exist. Everything this can possibly do to the outside world goes through
  // deps.gitClient / deps.githubClient, whose interfaces have no force-push,
  // merge, deploy, restart, or controlled-mode method — not "we chose not to
  // call them", there is nothing to call.
  //
  // Every FINAL transition this function makes (to pr_opened or
  // publish_failed) is guarded not just by state = "publishing" but by
  // leaseAttemptId = <the attempt id this call was handed>. This matters
  // because reconcileExpiredLease()'s reclaim is a publishing -> publishing
  // self-loop — it does NOT change state, only the lease fields — so a slow
  // original attempt that outlived its own lease and got reclaimed can still
  // observe state = "publishing" the whole way through its own execution and
  // reach ITS final transition believing it's still authoritative. Without
  // the attemptId fence, the base state guard alone would let that stale
  // attempt win the terminal write purely on timing, even though it was
  // already superseded. With the fence, its finalize fails (the row's
  // leaseAttemptId has moved on to the reclaimer's), gets caught by
  // finalizeOrAdoptConcurrentOutcome, and adopts whatever the row actually
  // holds instead of overwriting it. See
  // delivery-controller-lease-fencing.test.ts for the constructed race that
  // exercises exactly this.
  async function runPublishExecution(candidate: typeof deliveryCandidates.$inferSelect, actor: string) {
    assertValidSha(candidate.sha);
    if (!candidate.leaseAttemptId) {
      throw new Error(
        `runPublishExecution called with candidate ${candidate.id} which has no leaseAttemptId — every entry into "publishing" (claimForPublish, reconcileExpiredLease) sets one`,
      );
    }
    const attemptId = candidate.leaseAttemptId;
    const attemptGuard = eq(deliveryCandidates.leaseAttemptId, attemptId);

    const contract = candidate.routeContractId
      ? (
          await db
            .select({ retryBackoffSeconds: deliveryRouteContracts.retryBackoffSeconds })
            .from(deliveryRouteContracts)
            .where(eq(deliveryRouteContracts.id, candidate.routeContractId))
        )[0]
      : undefined;
    const backoffSeconds = contract?.retryBackoffSeconds ?? 60;

    const fail = (reason: string, evidence: Record<string, unknown>, classification: PublishFailureClassification) => {
      const failureCount = candidate.failureCount + 1;
      return finalizeOrAdoptConcurrentOutcome(candidate.id, () =>
        db.transaction(async (tx) => {
          const scopedTx = tx as unknown as Db;
          return transitionCandidate(scopedTx, candidate, "publish_failed", actor, {
            reason,
            evidence: { ...evidence, classification },
            extraGuard: attemptGuard,
            patch: {
              blockedReason: reason,
              failureCount,
              failureClassification: classification,
              nextRetryEarliestAt: classification === "transient" ? computeNextRetryEarliestAt(failureCount, backoffSeconds) : null,
            },
          });
        }));
    };

    try {
      await deps.gitClient.pushExactSha({
        repo: candidate.repo,
        sha: candidate.sha,
        branch: candidate.branch,
        localRepoDir: candidate.sourceArtifactPath,
      });
    } catch (error) {
      return fail(`Push failed: ${error instanceof Error ? error.message : String(error)}`, { step: "push" }, classifyPublishFailure(error));
    }

    let observedHead: string | null;
    try {
      observedHead = await deps.gitClient.readRemoteBranchHead({ repo: candidate.repo, branch: candidate.branch });
    } catch (error) {
      // The read-back check ITSELF failed (network/auth/unreachable) — this
      // is not "the branch is missing", it's "we could not tell". Must be
      // classified and routed through bounded retry exactly like the push
      // step above, not left uncaught: an uncaught throw here would
      // propagate out of runPublishExecution() entirely, leaving the row
      // stuck in "publishing" until lease expiry instead of failing fast.
      return fail(
        `Remote branch read-back failed: ${error instanceof Error ? error.message : String(error)}`,
        { step: "verify_push" },
        classifyPublishFailure(error),
      );
    }
    if (observedHead !== candidate.sha) {
      return fail(
        "Remote branch head does not match the pushed SHA after push",
        { step: "verify_push", expectedSha: candidate.sha, observedHead },
        "permanent", // a genuine mismatch (the check SUCCEEDED and disagrees) is never assumed safe to blindly retry
      );
    }
    const remoteBranchVerifiedAt = new Date();

    let pr: PullRequestInfo;
    try {
      const existing = await deps.githubClient.findOpenPullRequest({
        repo: candidate.repo,
        branch: candidate.branch,
        baseBranch: candidate.baseBranch,
      });
      pr =
        existing ??
        (await deps.githubClient.createPullRequest({
          repo: candidate.repo,
          branch: candidate.branch,
          baseBranch: candidate.baseBranch,
          title: `Delivery candidate ${candidate.sha.slice(0, 12)}`,
          body: `Automated by the delivery controller (candidate ${candidate.id}).\n\nRoute contract: ${candidate.routeContractId}\nSHA: ${candidate.sha}`,
        }));
    } catch (error) {
      // The push already landed (and is idempotent — the same SHA re-pushed
      // to the same ref on retry is a fast-forward no-op), so a retry from
      // here safely re-attempts only the PR step.
      return fail(
        `PR create/lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        { step: "create_pr" },
        classifyPublishFailure(error),
      );
    }

    let verified: PullRequestInfo | null;
    try {
      verified = await deps.githubClient.readPullRequest({ repo: candidate.repo, prNumber: pr.number });
    } catch (error) {
      // Same reasoning as the branch read-back above: the CHECK failed
      // (429/5xx/connectivity), not "the PR is missing" — classify and
      // route through bounded retry rather than leaving the row stuck in
      // "publishing" with an uncaught throw.
      return fail(
        `PR read-back failed: ${error instanceof Error ? error.message : String(error)}`,
        { step: "verify_pr", prNumber: pr.number },
        classifyPublishFailure(error),
      );
    }
    if (!verified || verified.headSha !== candidate.sha) {
      return fail(
        "PR read-back verification failed — PR does not exist or head SHA does not match",
        { step: "verify_pr", prNumber: pr.number, observedHeadSha: verified?.headSha ?? null },
        "permanent", // a genuine 404/mismatch (the check SUCCEEDED and disagrees) is never assumed safe to blindly retry
      );
    }

    return finalizeOrAdoptConcurrentOutcome(candidate.id, () =>
      db.transaction(async (tx) => {
        const scopedTx = tx as unknown as Db;
        return transitionCandidate(scopedTx, candidate, "pr_opened", actor, {
          extraGuard: attemptGuard,
          patch: {
            prUrl: verified.url,
            prNumber: verified.number,
            remoteBranchVerifiedAt,
            prVerifiedAt: new Date(),
          },
          evidence: { prNumber: verified.number, prUrl: verified.url, headSha: verified.headSha },
        });
      }));
  }

  // candidate_verified → publication_authorized → publishing → pr_opened | publish_failed | publication_blocked
  //
  // The operator-triggered path: claimForPublish() atomically decides
  // whether this call gets to act at all, then runPublishExecution() does
  // the actual work. The NORMAL path is runWorkerTick() in
  // delivery-controller-worker.ts, which calls the exact same two functions
  // on a schedule — this one exists so a human or a diagnostic script can
  // force an attempt right now instead of waiting for the next tick. See
  // that file's own header comment.
  async function publish(candidateId: string, actor: string) {
    const claim = await claimForPublish(candidateId, actor);
    if (claim.kind === "blocked") return claim.candidate; // never touched git or GitHub
    return runPublishExecution(claim.candidate, actor);
  }

  // Recovers a candidate whose claimant never came back — the process
  // crashed, was killed, or lost its connection mid-Phase-2 — WITHOUT any
  // human database repair. Finds the candidate still sitting in "publishing"
  // past its lease's expiry, atomically reclaims the lease (a fresh attempt
  // id/expiry/owner, guarded by BOTH the still-current state AND the
  // specific expired (attemptId, expiresAt) this call observed — see
  // transitionCandidate()'s extraGuard), then runs the exact same
  // runPublishExecution() a fresh claim would. Because every step in that
  // function is idempotent and read-back-verified (see its own comment),
  // "reconcile" and "retry from scratch" are the same operation: if the dead
  // attempt actually finished the push and/or PR before dying, this call
  // discovers that via the read-back checks and finalizes pr_opened without
  // redoing completed work; if it died before finishing, this call
  // completes it; if it never even reached the remote, this call runs the
  // whole thing.
  async function reconcileExpiredLease(
    candidateId: string,
    workerId: string,
  ): Promise<typeof deliveryCandidates.$inferSelect | null> {
    const reclaimed = await db.transaction(async (tx) => {
      const scopedTx = tx as unknown as Db;
      const [candidate] = await tx.select().from(deliveryCandidates).where(eq(deliveryCandidates.id, candidateId));
      if (!candidate) return null;
      if (candidate.state !== "publishing") return null; // nothing to reconcile
      if (!candidate.leaseAttemptId || !candidate.leaseExpiresAt || candidate.leaseExpiresAt.getTime() > Date.now()) {
        return null; // lease is missing or not actually expired — not eligible
      }

      const previousAttemptId = candidate.leaseAttemptId;
      try {
        return await transitionCandidate(scopedTx, candidate, "publishing", workerId, {
          patch: {
            leaseAttemptId: randomUUID(),
            leaseExpiresAt: new Date(Date.now() + PUBLISH_LEASE_DURATION_MS),
            leaseOwner: workerId,
          },
          reason: "lease expired — reclaimed for reconciliation",
          evidence: { previousAttemptId, previousLeaseOwner: candidate.leaseOwner },
          // The specific expired lease this call observed — if the original
          // claimant (or another reconciler) already moved the row on
          // (renewed the lease, or finished it) between our SELECT above and
          // this UPDATE, this guard fails to match and we lose the race
          // cleanly rather than stomping on live work.
          extraGuard: and(
            eq(deliveryCandidates.leaseAttemptId, previousAttemptId),
            lt(deliveryCandidates.leaseExpiresAt, new Date()),
          ),
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) return null; // lost the reclaim race
        throw error;
      }
    });
    if (!reclaimed) return null;
    return runPublishExecution(reclaimed, workerId);
  }

  // --- Worker activation gate ------------------------------------------
  // See delivery_worker_activation.ts's own header for the two-layer design
  // (env var in app.ts + this table). These four functions are the ONLY way
  // the gate is ever read or written; runWorkerTick() calls isWorkerActivated()
  // as the very first thing it does, before touching anything else.

  async function isWorkerActivated(): Promise<boolean> {
    const [row] = await db
      .select({ id: deliveryWorkerActivations.id })
      .from(deliveryWorkerActivations)
      .where(eq(deliveryWorkerActivations.status, "active"))
      .limit(1);
    return !!row;
  }

  // Idempotent — a second activate() while one is already active returns the
  // existing row rather than creating a duplicate, so "activate" is safe to
  // call repeatedly without needing to check status first.
  async function activateWorker(authorizedByUserId: string, reason?: string | null) {
    assertNonEmpty(authorizedByUserId, "authorizedByUserId");
    const existing = await db.select().from(deliveryWorkerActivations).where(eq(deliveryWorkerActivations.status, "active"));
    if (existing.length > 0) return existing[0]!;
    const [created] = await db
      .insert(deliveryWorkerActivations)
      .values({ authorizedByUserId, reason: reason ?? null })
      .returning();
    return created!;
  }

  // Revokes every currently-active row (there should be at most one, but
  // this does not assume that — no active row survives a deactivation call).
  async function deactivateWorker(revokedByUserId: string) {
    assertNonEmpty(revokedByUserId, "revokedByUserId");
    return db
      .update(deliveryWorkerActivations)
      .set({ status: "revoked", revokedByUserId, revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(deliveryWorkerActivations.status, "active"))
      .returning();
  }

  async function getWorkerActivationStatus() {
    const active = await db.select().from(deliveryWorkerActivations).where(eq(deliveryWorkerActivations.status, "active"));
    return { activated: active.length > 0, active };
  }

  return {
    submitCandidate,
    createRouteContract,
    revokeRouteContract,
    evaluatePublicationAuthorization,
    claimForPublish,
    publish,
    runPublishExecution,
    reconcileExpiredLease,
    getCandidate,
    listCandidates,
    listClaimableCandidateIds,
    listExpiredLeaseCandidateIds,
    listRetryableFailedCandidateIds,
    isWorkerActivated,
    activateWorker,
    deactivateWorker,
    getWorkerActivationStatus,
    listTransitions,
  };
}

export { computeRouteContractContentHash };
