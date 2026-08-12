import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  createDb,
  issues,
} from "../packages/db/src/index.js";
import {
  buildIdentifierBackfillPlan,
} from "../packages/shared/src/index.js";
import { loadConfig } from "../server/src/config.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  const companyId = parseFlag("--company");
  const sourcePrefix = parseFlag("--source-prefix");
  const apply = process.argv.includes("--apply");
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      issueNumber: issues.issueNumber,
      originKind: issues.originKind,
    })
    .from(issues)
    .where(companyId ? eq(issues.companyId, companyId) : undefined);
  const plan = buildIdentifierBackfillPlan(rows, {
    sourcePrefix: sourcePrefix ?? undefined,
  });
  const counts = new Map<string, number>();
  for (const change of plan.changes) {
    counts.set(change.originKind, (counts.get(change.originKind) ?? 0) + 1);
  }

  console.log(`Local identifier changes: ${plan.changes.length}`);
  for (const [originKind, count] of [...counts.entries()].sort()) {
    console.log(`- ${originKind}: ${count}`);
  }
  if (plan.collisions.length > 0) {
    console.error(`Refusing backfill: ${plan.collisions.length} identifier collision(s).`);
    for (const collision of plan.collisions.slice(0, 20)) {
      console.error(
        `- ${collision.targetIdentifier}: ${collision.candidateId} conflicts with ${collision.existingId}`,
      );
    }
    process.exitCode = 2;
    return;
  }
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after a database backup.");
    return;
  }
  if (plan.changes.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  await db.transaction(async (tx) => {
    for (const change of plan.changes) {
      await tx
        .update(issues)
        .set({
          identifier: change.targetIdentifier,
          updatedAt: new Date(),
        })
        .where(and(
          eq(issues.id, change.id),
          eq(issues.identifier, change.identifier),
        ));
    }
    await tx.insert(activityLog).values(plan.changes.map((change) => ({
      companyId: change.companyId,
      actorType: "system",
      actorId: "local-issue-identifier-backfill",
      action: "issue.identifier_backfilled",
      entityType: "issue",
      entityId: change.id,
      details: {
        previousIdentifier: change.identifier,
        identifier: change.targetIdentifier,
        originKind: change.originKind,
      },
    })));
  });

  const changedIds = plan.changes.map((change) => change.id);
  const persisted = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
    })
    .from(issues)
    .where(inArray(issues.id, changedIds));
  const persistedById = new Map(persisted.map((row) => [row.id, row.identifier]));
  const mismatches = plan.changes.filter(
    (change) => persistedById.get(change.id) !== change.targetIdentifier,
  );
  if (mismatches.length > 0) {
    throw new Error(`Readback failed for ${mismatches.length} issue(s)`);
  }
  console.log(`Updated and verified ${plan.changes.length} local issue identifier(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Local issue identifier backfill failed: ${message}`);
    process.exitCode = 1;
  });
}
