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

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("historical migration compatibility", () => {
  it("recognizes exactly the two approved historical TF hashes", () => {
    expect([...HISTORICAL_MIGRATION_HASHES.entries()]).toEqual([
      [
        "a064370e835d3a33f66187f373c32f9e1707f1ebeeda5ae59f7f0411d26b2754",
        "9002_evidence_provenance_registry.sql",
      ],
      [
        "8247dcc646e22c135b19896af4bbeca5f62554c0abac9bda57a923afdb8eaae9",
        "9003_restore_company_scoped_environments.sql",
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

    const resolution = resolveMigrationHistoryHashes(
      [...HISTORICAL_MIGRATION_HASHES.keys()],
      new Map(),
    );
    expect(resolution.appliedMigrations).toEqual([
      "9002_evidence_provenance_registry.sql",
      "9003_restore_company_scoped_environments.sql",
    ]);
    expect(migrationFiles).not.toEqual(expect.arrayContaining(resolution.appliedMigrations));
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
          ('8247dcc646e22c135b19896af4bbeca5f62554c0abac9bda57a923afdb8eaae9', 1785391098109)`,
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
});
