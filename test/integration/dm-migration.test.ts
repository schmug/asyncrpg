/**
 * The slice-1 schema, and the one migration hazard in it.
 *
 * Adding `beats.published_at` with a NULL default retroactively marks every
 * historical beat as "held in review", which would empty the chronicle of every
 * campaign in production. The backfill is the point of this test.
 *
 * These run against `migrations/*.sql` themselves, not a restatement of them
 * (see `test/helpers/schema.ts`). Deleting `0005_dm.sql`, or deleting its
 * `UPDATE beats` line, turns this file red.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  applySchema,
  applySchemaThrough,
  resetDatabase,
  splitStatements,
} from "../helpers/schema";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

/** Every table the five migrations create. `applySchema` must produce all of them. */
const PRODUCTION_TABLES = [
  "auth_tokens",
  "beats",
  "campaigns",
  "downtime",
  "email_loopback",
  "entities",
  "events",
  "invites",
  "journals",
  "letters",
  "memberships",
  "players",
  "projection_failures",
  "rate_limits",
  "reply_bindings",
  "settings",
  "token_budget",
];

/**
 * Statements per migration file.
 *
 * This is the guard on the splitter. Three of these files carry a semicolon
 * inside a `--` comment, so `split(";")` would report 24/3/7/2/8 and hand D1
 * sheared fragments; the numbers below are the real statement counts. If a
 * migration is edited, update the number deliberately — a surprise here means
 * the splitter mis-parsed something.
 */
const STATEMENT_COUNTS: Record<string, number> = {
  "0001_init.sql": 22,
  "0002_invites.sql": 3,
  "0003_ops.sql": 6,
  "0004_email_loopback.sql": 2,
  "0005_dm.sql": 8,
};

async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("the migration fixture", () => {
  it("splits every migration into whole statements", () => {
    for (const migration of MIGRATIONS) {
      expect(migration.queries.length, migration.name).toBe(
        STATEMENT_COUNTS[migration.name],
      );
      for (const query of migration.queries) {
        // A comment-semicolon shear leaves a fragment starting mid-sentence.
        // Every real statement here starts with one of these verbs.
        expect(query, `${migration.name}: ${query.slice(0, 60)}`).toMatch(
          /^(CREATE|ALTER|UPDATE|INSERT|DROP)\b/i,
        );
      }
    }
  });

  it("keeps a semicolon that lives inside a comment out of the statement stream", () => {
    const sql = [
      "-- a semicolon; inside a comment",
      "CREATE TABLE a (x TEXT DEFAULT 'has ; inside');",
      "CREATE TABLE b (y TEXT);",
    ].join("\n");
    expect(splitStatements(sql)).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT 'has ; inside')",
      "CREATE TABLE b (y TEXT)",
    ]);
  });

  it("creates every table this project uses", async () => {
    await resetDatabase(env.DB);
    await applySchema(env.DB);
    expect(await tableNames()).toEqual(
      expect.arrayContaining(PRODUCTION_TABLES),
    );
  });

  it("carries production's constraints, not a relaxed copy of them", async () => {
    await resetDatabase(env.DB);
    await applySchema(env.DB);
    // REFERENCES survives: a campaign with no such creator is rejected.
    await expect(
      env.DB.prepare(
        `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
         VALUES ('cmp_orphan', 'orphan', 'Orphan', 'weekly', 'plr_nobody', '2026-01-01T00:00:00Z')`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe("slice-1 schema", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
    await applySchema(env.DB);
  });

  it("gives campaigns a DM seat and a window, both empty by default", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO players (id, email, created_at) VALUES ('plr_a', 'a@example.com', ?)",
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES ('cmp_a', 'a', 'A', 'weekly', 'plr_a', ?)`,
    ).bind(now).run();

    const row = await env.DB.prepare(
      "SELECT dm_player_id, review_window_ms FROM campaigns WHERE id = 'cmp_a'",
    ).first<{ dm_player_id: string | null; review_window_ms: number | null }>();

    expect(row?.dm_player_id).toBeNull();
    expect(row?.review_window_ms).toBeNull();
  });

  it("gives beats the publication and revision columns", async () => {
    const now = new Date().toISOString();
    // `beats.campaign_id` REFERENCES campaigns, which REFERENCES players, so
    // the row this test is actually about needs both seeded first.
    await env.DB.prepare(
      "INSERT INTO players (id, email, created_at) VALUES ('plr_b', 'b@example.com', ?)",
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES ('cmp_b', 'b', 'B', 'weekly', 'plr_b', ?)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
       VALUES ('cmp_b', 1, 'The gate holds.', 'At the gate.', 'model', ?)`,
    ).bind(now).run();

    const row = await env.DB.prepare(
      "SELECT published_at, revised_by, original_prose FROM beats WHERE campaign_id = 'cmp_b'",
    ).first<{ published_at: string | null; revised_by: string | null; original_prose: string | null }>();

    expect(row).not.toBeNull();
    expect(row?.revised_by).toBeNull();
    expect(row?.original_prose).toBeNull();
  });
});

describe("the 0005 backfill", () => {
  /**
   * The hazard, reproduced: a beat that existed before `published_at` did.
   *
   * Applying 0001–0004 only, writing a beat against that older shape, and then
   * running 0005 over it is the one arrangement in which the `UPDATE beats SET
   * published_at = created_at` line does any work. Delete that line and this
   * test fails.
   */
  async function seedLegacyBeatThenMigrate(): Promise<void> {
    await resetDatabase(env.DB);
    await applySchemaThrough(env.DB, "0004_email_loopback.sql");

    await env.DB.prepare(
      "INSERT INTO players (id, email, created_at) VALUES ('plr_old', 'old@example.com', '2025-12-01T00:00:00Z')",
    ).run();
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES ('cmp_old', 'old', 'Old Hold', 'weekly', 'plr_old', '2025-12-01T00:00:00Z')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
       VALUES ('cmp_old', 1, 'The gate held, once.', 'At the gate.', 'model', '2026-01-01T00:00:00Z')`,
    ).run();

    await applySchema(env.DB);
  }

  it("has no published_at column before 0005 runs", async () => {
    await resetDatabase(env.DB);
    await applySchemaThrough(env.DB, "0004_email_loopback.sql");
    const { results } = await env.DB.prepare("PRAGMA table_info(beats)").all<{ name: string }>();
    expect(results.map((r) => r.name)).not.toContain("published_at");
  });

  it("leaves no pre-existing beat held in review", async () => {
    await seedLegacyBeatThenMigrate();

    const held = await env.DB.prepare(
      "SELECT count(*) AS n FROM beats WHERE published_at IS NULL",
    ).first<{ n: number }>();
    expect(held?.n).toBe(0);
  });

  it("backfills published_at from created_at, so the chronicle keeps its history", async () => {
    await seedLegacyBeatThenMigrate();

    const row = await env.DB.prepare(
      "SELECT published_at FROM beats WHERE campaign_id = 'cmp_old' AND tick = 1",
    ).first<{ published_at: string | null }>();

    expect(row?.published_at).toBe("2026-01-01T00:00:00Z");
  });

  it("still defaults a beat written after the migration to held", async () => {
    // The backfill must be a one-time repair, not a default that would make
    // `published_at` meaningless for beats the DM is supposed to hold.
    await seedLegacyBeatThenMigrate();
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
       VALUES ('cmp_old', 2, 'The gate holds.', 'At the gate.', 'model', '2026-02-01T00:00:00Z')`,
    ).run();

    const row = await env.DB.prepare(
      "SELECT published_at FROM beats WHERE campaign_id = 'cmp_old' AND tick = 2",
    ).first<{ published_at: string | null }>();

    expect(row?.published_at).toBeNull();
  });
});
