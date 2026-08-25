import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, check } from "drizzle-orm/pg-core";

export const DELIVERY_WORKER_ACTIVATION_STATUSES = ["active", "revoked"] as const;

// The gate that actually lets delivery-controller-worker.ts's scheduled tick
// touch git/GitHub unattended. Two independent layers, both default OFF:
//
//   1. PAPERCLIP_DELIVERY_WORKER_ENABLED env var, read once in app.ts — does
//      this process's scheduler timer run at all. A deploy-time operational
//      decision; changing it needs a restart/redeploy, which is deliberate
//      — it is the "this environment is allowed to run an automatic
//      publisher at all" boundary (e.g. off in staging, on in prod).
//   2. This table — does the worker's tick logic actually do anything once
//      it fires. An instance-admin-authorized, DB-recorded, runtime-
//      revocable decision — no restart needed to pause or resume — using
//      the same authorizedByUserId/revokedByUserId shape as
//      delivery_route_contracts, for the same reason: this is a real
//      human-authority boundary, not a config convenience.
//
// A deployment with the env var on but no active row here runs a scheduler
// that ticks on schedule and does nothing every time, until a human
// explicitly activates it — see isWorkerActivated()/activateWorker() in
// delivery-controller.ts and runWorkerTick()'s own gate check.
export const deliveryWorkerActivations = pgTable(
  "delivery_worker_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").notNull().default("active"), // active | revoked
    reason: text("reason"),
    authorizedByUserId: text("authorized_by_user_id").notNull(),
    revokedByUserId: text("revoked_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // sql.raw(), not sql`${...}` interpolation — see delivery_candidates.ts's
    // stateVocabularyCheck for why (DDL, not a parameterized query).
    statusVocabularyCheck: check(
      "delivery_worker_activations_status_check",
      sql`${table.status} in (${sql.raw(DELIVERY_WORKER_ACTIVATION_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
  }),
);
