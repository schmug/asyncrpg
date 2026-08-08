/**
 * Event projection carries `targetIds`.
 *
 * For many event kinds `actorId` is null and `targetIds` is the only link back
 * to the entity, so without this the read model can answer "what did X do" but
 * not "what happened to X". See issue #7.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (campaign_id TEXT NOT NULL, event_id TEXT NOT NULL,
  tick INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, region_id TEXT,
  summary TEXT NOT NULL, significance INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  target_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, event_id));
`;

const CAMPAIGN = "cmp_projection";

describe("event projection", () => {
  beforeAll(async () => {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM events WHERE campaign_id = ?").bind(CAMPAIGN).run();
  });

  it("finds an event by an id that appears only in targetIds", async () => {
    // The shape that fails today: no actor, entity named only as a target.
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, data, target_ids, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, '{}', ?, ?)`,
    )
      .bind(
        CAMPAIGN, "evt_1", 4, "prosperity_shift", "rgn_0",
        "Trade thinned at Vresford.", 34, JSON.stringify(["stl_3"]),
        new Date().toISOString(),
      )
      .run();

    const found = await env.DB.prepare(
      `SELECT event_id FROM events
       WHERE campaign_id = ?1
         AND EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)`,
    )
      .bind(CAMPAIGN, "stl_3")
      .all<{ event_id: string }>();

    expect(found.results?.map((r) => r.event_id)).toEqual(["evt_1"]);
  });

  it("defaults to an empty array for rows written before the migration", async () => {
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, data, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, '{}', ?)`,
    )
      .bind(CAMPAIGN, "evt_old", 1, "unrest_shift", "Old row.", 20, new Date().toISOString())
      .run();

    const row = await env.DB.prepare(
      "SELECT target_ids FROM events WHERE campaign_id = ? AND event_id = ?",
    )
      .bind(CAMPAIGN, "evt_old")
      .first<{ target_ids: string }>();

    expect(row?.target_ids).toBe("[]");
  });

  it("replaying an event through the same insert populates target_ids", async () => {
    // Stands in for reproject(): the DO replays retained WorldEvent objects
    // through #writeEvents, so anything that path writes, the repair writes.
    const replay = { targetIds: ["fac_2", "stl_1"], data: {} };
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, target_ids, data, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, event_id) DO NOTHING`,
    )
      .bind(
        CAMPAIGN, "evt_replay", 7, "war_declared", "War was declared.", 80,
        JSON.stringify(replay.targetIds), JSON.stringify(replay.data),
        new Date().toISOString(),
      )
      .run();

    const found = await env.DB.prepare(
      `SELECT event_id FROM events
       WHERE campaign_id = ?1
         AND EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)`,
    )
      .bind(CAMPAIGN, "fac_2")
      .all<{ event_id: string }>();

    expect(found.results).toHaveLength(1);
  });
});
