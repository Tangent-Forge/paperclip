/**
 * Applied migration identities that remain in the live fork database but are
 * intentionally not part of the upstream core migration set. These entries
 * let migration inspection account for historical rows without making the
 * corresponding SQL runnable on a fresh database before its ownership and
 * contract have been decided.
 */
export const HISTORICAL_MIGRATION_HASHES = new Map<string, string>([
  [
    "a064370e835d3a33f66187f373c32f9e1707f1ebeeda5ae59f7f0411d26b2754",
    "9002_evidence_provenance_registry.sql",
  ],
  [
    "8247dcc646e22c135b19896af4bbeca5f62554c0abac9bda57a923afdb8eaae9",
    "9003_restore_company_scoped_environments.sql",
  ],
]);

// Upstream's migration runner also has one historical filename alias used by
// an existing regression fixture. It maps to the legacy filename intentionally
// (rather than 0140): the legacy row must remain historical while 0140 stays
// pending and repairs the current schema. Keep it separate from the two TF-only
// hashes above: it is an upstream compatibility identity, not absent TF SQL.
export const UPSTREAM_MIGRATION_HASH_ALIASES = new Map<string, string>([
  [
    "03be42e4fe3d0010942e542d3ad7604bcdb3601eb41f4e231227c453d5f74801",
    "legacy 0136_built_in_managed_resources.sql",
  ],
]);

export type MigrationHistoryResolution = {
  appliedMigrations: string[];
  unknownHashes: string[];
};

export function resolveMigrationHistoryHashes(
  appliedHashes: readonly string[],
  knownHashes: ReadonlyMap<string, string>,
): MigrationHistoryResolution {
  const appliedMigrations: string[] = [];
  const unknownHashes: string[] = [];

  for (const hash of appliedHashes) {
    const migrationFile =
      knownHashes.get(hash) ??
      HISTORICAL_MIGRATION_HASHES.get(hash) ??
      UPSTREAM_MIGRATION_HASH_ALIASES.get(hash);
    if (migrationFile) appliedMigrations.push(migrationFile);
    else unknownHashes.push(hash);
  }

  return { appliedMigrations, unknownHashes };
}

export function assertKnownMigrationHistory(
  resolution: MigrationHistoryResolution,
): void {
  if (resolution.unknownHashes.length === 0) return;
  throw new Error(
    `Unrecognized migration history hash(es): ${resolution.unknownHashes.join(", ")}`,
  );
}

export function pendingMigrationFiles(
  availableMigrations: readonly string[],
  appliedMigrations: readonly string[],
): string[] {
  const applied = new Set(appliedMigrations);
  return availableMigrations.filter((migrationFile) => !applied.has(migrationFile));
}
