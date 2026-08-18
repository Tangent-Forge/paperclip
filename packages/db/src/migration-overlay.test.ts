import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeMigrationOverlayFiles } from "./migration-overlay.js";

describe("TF migration overlay ordering", () => {
  it("keeps the reserved TF layer after the adopted upstream sequence", () => {
    const migrations = fs
      .readdirSync(new URL("./migrations", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const upstream = migrations.filter((name) => !name.startsWith("9"));
    const overlay = migrations.filter((name) => name.startsWith("9"));

    expect(mergeMigrationOverlayFiles(upstream, overlay)).toEqual(migrations);
  });

  it("re-appends the retained TF layer deterministically when upstream adds 0224", () => {
    expect(
      mergeMigrationOverlayFiles(
        ["0223_robust_zaladane.sql", "0224_future_upstream.sql"],
        ["9001_agent_wakeup_active_idempotency_uq.sql"],
      ),
    ).toEqual([
      "0223_robust_zaladane.sql",
      "0224_future_upstream.sql",
      "9001_agent_wakeup_active_idempotency_uq.sql",
    ]);
  });

  it("rejects duplicate or non-overlay TF entries", () => {
    expect(() =>
      mergeMigrationOverlayFiles(
        ["0223_robust_zaladane.sql"],
        ["0223_robust_zaladane.sql"],
      ),
    ).toThrow("Duplicate migration file");
    expect(() =>
      mergeMigrationOverlayFiles(
        ["0223_robust_zaladane.sql"],
        ["0899_invalid_overlay.sql"],
      ),
    ).toThrow("reserved 9000+ band");
    expect(() =>
      mergeMigrationOverlayFiles(
        ["9002_upstream_collision.sql"],
        ["9001_agent_wakeup_active_idempotency_uq.sql"],
      ),
    ).toThrow("Upstream migration occupies the reserved 9000+ TF overlay band");
    expect(() =>
      mergeMigrationOverlayFiles(
        ["0223_robust_zaladane.sql"],
        ["9_not_four_digits.sql"],
      ),
    ).toThrow("reserved 9000+ band");
  });
});
