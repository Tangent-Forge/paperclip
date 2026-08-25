/**
 * The repository has one Drizzle migration folder/journal. TF-owned core
 * migrations therefore use a reserved 9000+ filename band and are appended
 * after the adopted upstream sequence by a deterministic journal merge.
 */
export const TF_MIGRATION_OVERLAY_PREFIX = "9";
const TF_MIGRATION_OVERLAY_PATTERN = /^9\d{3}_/;

function isTfOverlayMigration(migrationFile: string): boolean {
  return TF_MIGRATION_OVERLAY_PATTERN.test(migrationFile);
}

export function mergeMigrationOverlayFiles(
  upstreamMigrations: readonly string[],
  tfOverlayMigrations: readonly string[],
): string[] {
  const upstream = [...upstreamMigrations].sort();
  const overlay = [...tfOverlayMigrations].sort();
  const all = [...upstream, ...overlay];
  const seen = new Set<string>();

  for (const migrationFile of all) {
    if (seen.has(migrationFile)) {
      throw new Error(`Duplicate migration file in upstream/TF overlay: ${migrationFile}`);
    }
    seen.add(migrationFile);
  }

  for (const migrationFile of overlay) {
    if (!isTfOverlayMigration(migrationFile)) {
      throw new Error(`TF overlay migration must use the reserved 9000+ band: ${migrationFile}`);
    }
  }

  if (upstream.some((migrationFile) => isTfOverlayMigration(migrationFile))) {
    throw new Error("Upstream migration occupies the reserved 9000+ TF overlay band");
  }

  const lastUpstream = upstream.at(-1);
  if (lastUpstream && overlay.some((migrationFile) => migrationFile <= lastUpstream)) {
    throw new Error("TF overlay migration sorts before the adopted upstream sequence");
  }

  return all;
}
