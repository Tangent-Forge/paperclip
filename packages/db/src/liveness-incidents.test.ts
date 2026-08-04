import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-liveness-incident-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function setupSql() {
  const connectionString = await createTempDatabase();
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  return { connectionString, sql };
}

async function seedCompany(sql: postgres.Sql) {
  const [{ id }] = await sql.unsafe<{ id: string }[]>(`
    INSERT INTO companies (name)
    VALUES ('Acme Co')
    RETURNING id
  `);
  return id;
}

async function seedIssue(sql: postgres.Sql, companyId: string, overrides: Record<string, unknown> = {}) {
  const cols = ["company_id", "title", "status", "origin_kind", "origin_fingerprint", "created_at", "updated_at"];
  const values = [
    `'${companyId}'`,
    `'${String(overrides.title ?? "Issue")}'`,
    `'${String(overrides.status ?? "backlog")}'`,
    `'${String(overrides.origin_kind ?? "manual")}'`,
    `'${String(overrides.origin_fingerprint ?? "default")}'`,
    `now()`,
    `now()`,
  ];
  if (overrides.origin_id !== undefined) {
    cols.splice(4, 0, "origin_id");
    values.splice(4, 0, `'${String(overrides.origin_id)}'`);
  }
  if (overrides.liveness_incident_id !== undefined) {
    cols.splice(cols.indexOf("created_at"), 0, "liveness_incident_id");
    values.splice(values.indexOf(`now()`), 0, `'${String(overrides.liveness_incident_id)}'`);
  }
  const [{ id }] = await sql.unsafe<{ id: string }[]>(`
    INSERT INTO issues (${cols.map((c) => `"${c}"`).join(", ")})
    VALUES (${values.join(", ")})
    RETURNING id
  `);
  return id;
}

describeEmbeddedPostgres("liveness incident schema", () => {
  it("enforces canonical, sentinel, outbox, reconcile, and supersession constraints", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);
    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = await seedCompany(sql);
      const incidentId = `00000000-0000-0000-0000-000000000111`;
      await sql.unsafe(`
        INSERT INTO liveness_incidents (
          id, company_id, source_provider, source_origin_id, incident_class,
          state, generation, consecutive_present, consecutive_absent,
          first_seen_at, last_seen_at, evidence, created_at, updated_at
        ) VALUES (
          '${incidentId}', '${companyId}', 'paperclip:issue', 'issue-1', 'stale_recovery',
          'observed', 1, 0, 0, now(), now(), '{}'::jsonb, now(), now()
        )
      `);
      await expect(sql.unsafe(`
        INSERT INTO liveness_incidents (
          id, company_id, source_provider, source_origin_id, incident_class,
          state, generation, consecutive_present, consecutive_absent,
          first_seen_at, last_seen_at, evidence, created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000112', '${companyId}', 'paperclip:issue', 'issue-1', 'stale_recovery',
          'observed', 1, 0, 0, now(), now(), '{}'::jsonb, now(), now()
        )
      `)).rejects.toThrow();

      const sentinelA = await seedIssue(sql, companyId, {
        origin_kind: "harness_liveness_escalation",
        origin_id: incidentId,
        origin_fingerprint: "fingerprint-a",
      });
      const sentinelB = await seedIssue(sql, companyId, {
        origin_kind: "harness_liveness_escalation",
        origin_id: `${incidentId}-dup`,
        origin_fingerprint: "fingerprint-b",
      });
      await sql.unsafe(`UPDATE issues SET liveness_incident_id = '${incidentId}' WHERE id = '${sentinelA}'`);
      await expect(sql.unsafe(`UPDATE issues SET liveness_incident_id = '${incidentId}' WHERE id = '${sentinelB}'`)).rejects.toThrow();

      await sql.unsafe(`
        INSERT INTO liveness_effect_outbox (
          id, incident_id, generation, effect_kind, payload, status, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000211', '${incidentId}', 1, 'open_or_reopen_sentinel', '{}'::jsonb,
          'pending', 0, now(), now(), now()
        )
      `);
      await expect(sql.unsafe(`
        INSERT INTO liveness_effect_outbox (
          id, incident_id, generation, effect_kind, payload, status, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000212', '${incidentId}', 1, 'open_or_reopen_sentinel', '{}'::jsonb,
          'pending', 0, now(), now(), now()
        )
      `)).rejects.toThrow();

      await expect(sql.unsafe(`
        INSERT INTO liveness_reconcile_runs (
          id, started_at, completed_at, status, disposition, observed_count, activated_count,
          cleared_count, effect_count, error_summary
        ) VALUES (
          '00000000-0000-0000-0000-000000000311', now(), now(), 'running', 'no_change', 1, 0, 0, 0, null
        )
      `)).rejects.toThrow();

      await expect(sql.unsafe(`
        INSERT INTO liveness_reconcile_runs (
          id, started_at, completed_at, status, disposition, observed_count, activated_count,
          cleared_count, effect_count, error_summary
        ) VALUES (
          '00000000-0000-0000-0000-000000000312', now(), now(), 'bogus', 'no_change', 0, 0, 0, 0, null
        )
      `)).rejects.toThrow();

      await expect(sql.unsafe(`
        INSERT INTO liveness_effect_outbox (
          id, incident_id, generation, effect_kind, payload, status, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000213', '${incidentId}', 0, 'enqueue_wake', '{}'::jsonb,
          'pending', 0, now(), now(), now()
        )
      `)).rejects.toThrow();

      await expect(sql.unsafe(`
        INSERT INTO liveness_sentinel_supersessions (
          duplicate_issue_id, canonical_issue_id, incident_id, reason, audit_manifest_sha256, recorded_at
        ) VALUES (
          '${sentinelA}', '${sentinelA}', '${incidentId}', 'historical_duplicate', 'deadbeef', now()
        )
      `)).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("keeps repeated clear/reopen cycles on one incident row", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);
    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = await seedCompany(sql);
      await sql.unsafe(`
        INSERT INTO liveness_incidents (
          id, company_id, source_provider, source_origin_id, incident_class,
          state, generation, consecutive_present, consecutive_absent,
          first_seen_at, last_seen_at, evidence, created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000411', '${companyId}', 'paperclip:issue', 'issue-1', 'stale_recovery',
          'active', 1, 2, 0, now(), now(), '{}'::jsonb, now(), now()
        )
        ON CONFLICT (company_id, source_provider, source_origin_id, incident_class)
        DO UPDATE SET generation = liveness_incidents.generation + 1, state = EXCLUDED.state, updated_at = now()
      `);
      await sql.unsafe(`
        INSERT INTO liveness_incidents (
          id, company_id, source_provider, source_origin_id, incident_class,
          state, generation, consecutive_present, consecutive_absent,
          first_seen_at, last_seen_at, evidence, created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000412', '${companyId}', 'paperclip:issue', 'issue-1', 'stale_recovery',
          'cleared', 2, 0, 2, now(), now(), '{}'::jsonb, now(), now()
        )
        ON CONFLICT (company_id, source_provider, source_origin_id, incident_class)
        DO UPDATE SET generation = liveness_incidents.generation + 1, state = EXCLUDED.state, updated_at = now()
      `);
      const rows = await sql.unsafe<{ count: string; generation: number }[]>(`
        SELECT count(*)::text AS count, max(generation) AS generation
        FROM liveness_incidents
        WHERE company_id = '${companyId}' AND source_provider = 'paperclip:issue' AND source_origin_id = 'issue-1'
      `);
      expect(rows[0]).toMatchObject({ count: "1", generation: 2 });
    } finally {
      await sql.end();
    }
  });
});
