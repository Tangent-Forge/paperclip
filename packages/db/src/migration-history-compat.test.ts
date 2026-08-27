import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
} from "./client.js";
import {
  assertKnownMigrationHistory,
  HISTORICAL_MIGRATION_HASHES,
  UPSTREAM_MIGRATION_HASH_ALIASES,
  pendingMigrationFiles,
  resolveMigrationHistoryHashes,
} from "./migration-history-compat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("historical migration compatibility", () => {
  it("recognizes exactly the approved historical TF hashes", () => {
    expect([...HISTORICAL_MIGRATION_HASHES.entries()]).toEqual([
      [
        "a064370e835d3a33f66187f373c32f9e1707f1ebeeda5ae59f7f0411d26b2754",
        "9002_evidence_provenance_registry.sql",
      ],
      [
        "8247dcc646e22c135b19896af4bbeca5f62554c0abac9bda57a923afdb8eaae9",
        "9003_restore_company_scoped_environments.sql",
      ],
      [
        "4ed32969bf2be72afc4b7cca484de545fd7fb111ec420832938cc6bad6755e95",
        "historical 0103_environments_company_id_reconciliation.sql",
      ],
    ]);
  });

  it("does not make absent historical SQL executable", () => {
    const migrationFiles = fs
      .readdirSync(new URL("./migrations", import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name);

    expect(migrationFiles).not.toContain("9002_evidence_provenance_registry.sql");
    expect(migrationFiles).not.toContain("9003_restore_company_scoped_environments.sql");
    expect(migrationFiles).not.toContain("historical 0103_environments_company_id_reconciliation.sql");

    const resolution = resolveMigrationHistoryHashes(
      [...HISTORICAL_MIGRATION_HASHES.keys()],
      new Map(),
    );
    expect(resolution.appliedMigrations).toEqual([
      "9002_evidence_provenance_registry.sql",
      "9003_restore_company_scoped_environments.sql",
      "historical 0103_environments_company_id_reconciliation.sql",
    ]);
    expect(migrationFiles).not.toEqual(expect.arrayContaining(resolution.appliedMigrations));
  });

  it("keeps the upstream 0140 fixture alias separate from TF-only history", () => {
    const resolution = resolveMigrationHistoryHashes(
      [...UPSTREAM_MIGRATION_HASH_ALIASES.keys()],
      new Map(),
    );
    expect(resolution).toEqual({
      appliedMigrations: ["legacy 0136_built_in_managed_resources.sql"],
      unknownHashes: [],
    });
    expect([...HISTORICAL_MIGRATION_HASHES.values()]).not.toContain("legacy 0136_built_in_managed_resources.sql");
  });

  it("does not mark an unrelated or new migration as applied", () => {
    const resolution = resolveMigrationHistoryHashes(
      ["new-migration-hash"],
      new Map([["known-hash", "0000_mature_masked_marvel.sql"]]),
    );

    expect(resolution.appliedMigrations).toEqual([]);
    expect(resolution.unknownHashes).toEqual(["new-migration-hash"]);
    expect(() => assertKnownMigrationHistory(resolution)).toThrow(
      "Unrecognized migration history hash(es): new-migration-hash",
    );
  });

  it("preserves pending-migration detection around the historical overlay", () => {
    const available = [
      "0184_routable_blocked.sql",
      "0223_robust_zaladane.sql",
      "9001_agent_wakeup_active_idempotency_uq.sql",
    ];
    const resolution = resolveMigrationHistoryHashes(
      [
        "upstream-0183-hash",
        "a064370e835d3a33f66187f373c32f9e1707f1ebeeda5ae59f7f0411d26b2754",
        "8247dcc646e22c135b19896af4bbeca5f62554c0abac9bda57a923afdb8eaae9",
        "9001-hash",
      ],
      new Map([
        ["upstream-0183-hash", "0183_connection_user_authorization_state.sql"],
        ["9001-hash", "9001_agent_wakeup_active_idempotency_uq.sql"],
      ]),
    );

    assertKnownMigrationHistory(resolution);
    expect(pendingMigrationFiles(available, resolution.appliedMigrations)).toEqual([
      "0184_routable_blocked.sql",
      "0223_robust_zaladane.sql",
    ]);
  });
});

describeEmbeddedPostgres("historical migration compatibility against migration runner", () => {
  it("applies the fresh-database sequence and creates the retained 9001 index", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-migration-overlay-fresh-");
    cleanups.push(database.cleanup);

    await applyPendingMigrations(database.connectionString);

    const state = await inspectMigrations(database.connectionString);
    expect(state.status).toBe("upToDate");

    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const indexes = await sql.unsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'agent_wakeup_requests_active_idempotency_uq'`,
      );
      expect(indexes).toHaveLength(1);
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("recognizes an existing TF history and rejects a new unknown hash", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-migration-overlay-existing-");
    cleanups.push(database.cleanup);

    await applyPendingMigrations(database.connectionString);

    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
          ('a064370e835d3a33f66187f373c32f9e1707f1ebeeda5ae59f7f0411d26b2754', 1785391098075),
          ('8247dcc646e22c135b19896af4bbeca5f62554c0abac9bda57a923afdb8eaae9', 1785391098109),
          ('4ed32969bf2be72afc4b7cca484de545fd7fb111ec420832938cc6bad6755e95', 1787643806703)`,
      );
    } finally {
      await sql.end();
    }

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const unknownSql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await unknownSql.unsafe(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unknown-history-hash', 1787000753490)`,
      );
    } finally {
      await unknownSql.end();
    }

    await expect(inspectMigrations(database.connectionString)).rejects.toThrow(
      "Unrecognized migration history hash(es): unknown-history-hash",
    );
  }, 60_000);

  it("repairs a post-0105 company-scope regression with a forward migration", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-migration-env-forward-repair-");
    cleanups.push(database.cleanup);

    await applyPendingMigrations(database.connectionString);
    const repairMigration = "9005_restore_instance_scoped_environments.sql";
    const repairHash = await migrationHash(repairMigration);

    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`ALTER TABLE "environments" ADD COLUMN "company_id" uuid`);
      await sql.unsafe(`CREATE INDEX "environments_company_status_idx" ON "environments" ("company_id", "status")`);
      await sql.unsafe(`CREATE UNIQUE INDEX "environments_company_driver_idx" ON "environments" ("company_id", "driver") WHERE "driver" = 'local'`);
      await sql.unsafe(`CREATE INDEX "environments_company_name_idx" ON "environments" ("company_id", "name")`);
      await sql.unsafe(`CREATE UNIQUE INDEX "environments_company_managed_sandbox_idx" ON "environments" ("company_id") WHERE "driver" = 'sandbox' AND ("metadata" ->> 'managedByPaperclip')::boolean = true`);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${repairHash}`;
      await sql.unsafe(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
          ('4ed32969bf2be72afc4b7cca484de545fd7fb111ec420832938cc6bad6755e95', 1787643806703)`,
      );
    } finally {
      await sql.end();
    }

    const before = await inspectMigrations(database.connectionString);
    expect(before).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: expect.arrayContaining([repairMigration]),
    });

    await applyPendingMigrations(database.connectionString);

    const verifySql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const columns = await verifySql.unsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'environments'`,
      );
      const indexes = await verifySql.unsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'environments'`,
      );
      expect(columns.map((row) => row.column_name)).not.toContain("company_id");
      expect(indexes.map((row) => row.indexname)).not.toEqual(expect.arrayContaining([
        "environments_company_status_idx",
        "environments_company_driver_idx",
        "environments_company_name_idx",
        "environments_company_managed_sandbox_idx",
      ]));
      expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
        "environments_status_idx",
        "environments_local_driver_idx",
        "environments_name_idx",
        "environments_managed_sandbox_idx",
      ]));
    } finally {
      await verifySql.end();
    }
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);
});
