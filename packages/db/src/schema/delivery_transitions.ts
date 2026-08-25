import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { deliveryCandidates, DELIVERY_CANDIDATE_STATES } from "./delivery_candidates.js";

// Append-only audit log — every state change a delivery_candidates row ever
// makes gets one row here, including failed/blocked transitions. This is the
// "machine-readable failure/retry state" the closure contract needs: instead
// of a single mutable status column being the only record, the full history
// of attempts (contract evaluated and rejected, publish attempted and
// failed, retried and succeeded) stays queryable. Never updated or deleted
// once written.
export const deliveryTransitions = pgTable(
  "delivery_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id").notNull().references(() => deliveryCandidates.id),
    fromState: text("from_state"), // null for the initial submission transition
    toState: text("to_state").notNull(),
    actor: text("actor").notNull(), // e.g. "system:publisher-adapter", "human:<id>"
    reason: text("reason"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidateOccurredIdx: index("delivery_transitions_candidate_occurred_idx").on(
      table.candidateId,
      table.occurredAt,
    ),
    // Enforced at the database, not just by transitionCandidate()'s own
    // LEGAL_TRANSITIONS check — a row written by any means outside the
    // service (a raw SQL insert, a future bug) still cannot record a state
    // outside the known vocabulary.
    // sql.raw(), not sql`${...}` interpolation — see delivery_candidates.ts's
    // stateVocabularyCheck for why (DDL, not a parameterized query).
    toStateVocabularyCheck: check(
      "delivery_transitions_to_state_check",
      sql`${table.toState} in (${sql.raw(DELIVERY_CANDIDATE_STATES.map((s) => `'${s}'`).join(", "))})`,
    ),
    fromStateVocabularyCheck: check(
      "delivery_transitions_from_state_check",
      sql`${table.fromState} is null or ${table.fromState} in (${sql.raw(DELIVERY_CANDIDATE_STATES.map((s) => `'${s}'`).join(", "))})`,
    ),
  }),
);
