/**
 * The slice-1 schema, and the one migration hazard in it.
 *
 * Adding `beats.published_at` with a NULL default retroactively marks every
 * historical beat as "held in review", which would empty the chronicle of every
 * campaign in production. The backfill is the point of this test.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../helpers/schema";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

describe("slice-1 schema", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    for (const t of ["beats", "campaigns", "players"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
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
