/**
 * Event projection carries `targetIds`.
 *
 * For many event kinds `actorId` is null and `targetIds` is the only link back
 * to the entity, so without this the read model can answer "what did X do" but
 * not "what happened to X". See issue #7.
 *
 * Two kinds of coverage live here. The first `describe` composes raw SQL
 * against a self-declared schema — it documents the `json_each` query
 * semantics and the upsert-conflict behavior directly, cheaply, and in
 * isolation. It does NOT exercise `src/campaign-do.ts` at all: reverting
 * `#writeEvents` to before this fix leaves it green. The second `describe`
 * drives the real `CampaignDO` — `resolveTick` and `reproject` — through its
 * actual public RPCs, so the column bind and the upsert clause are both
 * exercised for real, and a regression in either one fails this file.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

// Both `describe` blocks below need `events`. The second also drives the real
// `CampaignDO`, which along that path writes `entities` (#writeEntities),
// `beats` (#project), and reads `memberships`/`players` (#fanOut) — all
// deliberately swallowed on failure (see #recordProjectionFailure and the
// fan-out catch in src/campaign-do.ts), so a missing table there does not
// fail a test, it just prints "projection failed" / "fan-out failed" noise
// and quietly stops covering that write. That noise is exactly the kind of
// expected-looking failure a real regression could hide inside — this
// node's whole subject is a projection bug that stayed invisible for
// months — so every table the DO touches on this path is declared here too,
// column-for-column with migrations/0001_init.sql (FK/CHECK constraints
// dropped, as the rest of this repo's test schemas already do).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (campaign_id TEXT NOT NULL, event_id TEXT NOT NULL,
  tick INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, region_id TEXT,
  summary TEXT NOT NULL, significance INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  target_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, event_id));
CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (campaign_id TEXT NOT NULL, player_id TEXT NOT NULL,
  character_id TEXT NOT NULL, character_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player',
  joined_at TEXT NOT NULL, PRIMARY KEY (campaign_id, player_id));
CREATE TABLE IF NOT EXISTS entities (campaign_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (campaign_id, entity_id));
CREATE TABLE IF NOT EXISTS beats (campaign_id TEXT NOT NULL, tick INTEGER NOT NULL,
  prose TEXT NOT NULL, situation TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (campaign_id, tick));
`;

const CAMPAIGN = "cmp_projection";

beforeAll(async () => {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
});

describe("event projection — raw SQL, schema and upsert semantics", () => {
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

  it("a replay upsert repairs a stale row instead of leaving it untouched", async () => {
    // The shape every row needing backfill is actually in: already in D1,
    // written before this fix, target_ids left at the column default.
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, target_ids, data, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, '[]', '{}', ?)`,
    )
      .bind(CAMPAIGN, "evt_replay", 7, "war_declared", "War was declared.", 80, new Date().toISOString())
      .run();

    // The same event_id, replayed through the same insert shape #writeEvents
    // uses, carrying the real ids — this is what reproject() does. The row
    // already exists, so this is a genuine conflict: with `ON CONFLICT ...
    // DO NOTHING` the replay is silently discarded and the row stays stale
    // forever, because the row already existing is exactly why it needed
    // backfilling. See #writeEvents in src/campaign-do.ts for why the clause
    // is `DO UPDATE SET target_ids = excluded.target_ids`, not `DO NOTHING`.
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, target_ids, data, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, event_id) DO UPDATE SET target_ids = excluded.target_ids`,
    )
      .bind(
        CAMPAIGN, "evt_replay", 7, "war_declared", "War was declared.", 80,
        JSON.stringify(["fac_2", "stl_1"]), "{}", new Date().toISOString(),
      )
      .run();

    const row = await env.DB.prepare(
      "SELECT target_ids FROM events WHERE campaign_id = ? AND event_id = ?",
    )
      .bind(CAMPAIGN, "evt_replay")
      .first<{ target_ids: string }>();

    expect(JSON.parse(row?.target_ids ?? "[]")).toEqual(["fac_2", "stl_1"]);
  });
});

describe("event projection — the real DO", () => {
  // Everything above composes raw SQL. Nothing there loads
  // `src/campaign-do.ts`, so nothing there would notice the `target_ids`
  // bind being dropped or reordered inside `#writeEvents`, or the upsert
  // clause being reverted to `DO NOTHING`. This drives the actual production
  // call paths — `resolveTick` -> `#project` -> `#writeEvents`, and
  // `reproject` -> `#writeEvents` — through the real `CampaignDO` RPC.
  const CAMPAIGN_ID = "cmp_projection_do";

  // Generous on purpose. This drives a real Durable Object through genesis, a
  // full tick, and a reproject; ~3.5s alone is legitimate work, not a hang, and
  // it sat close enough to the 5s default to time out once under parallel load.
  // A slow-but-correct integration test must not be tuned to the default's edge.
  it("resolveTick writes real target_ids, and reproject repairs a stale row", { timeout: 20_000 }, async () => {
    const stub = env.CAMPAIGN.get(env.CAMPAIGN.idFromName(CAMPAIGN_ID));

    await stub.init({
      campaignId: CAMPAIGN_ID,
      slug: "projection-do",
      name: "Projection DO Test",
      cadence: "weekly",
      // Small on purpose: the test only needs the initial roster, not a deep
      // pre-play history.
      historyYears: 1,
    });

    const world = await stub.debugWorld();
    const settlement = Object.values(world.settlements)[0];
    if (!settlement) throw new Error("genesis produced no settlements to target");

    await stub.join("plr_1", "Tester", "scout");
    // No ANTHROPIC_API_KEY in tests, so intent parsing falls back to
    // src/dm/intent.ts `parseIntentKeywords`, which resolves the longest
    // named entity mentioned in the text to `targetId`. Naming the
    // settlement here is what makes the resulting event's targetIds
    // deterministic, rather than depending on a random drift crossing a
    // threshold (genesis events default targetIds to `[]` — see
    // src/sim/events.ts — so genesis alone would not exercise this).
    const submitted = await stub.submitAction(
      "plr_1",
      `I investigate what is happening in ${settlement.name}.`,
      "web",
    );
    // One active character and the default quorumFraction of 0.5 give a
    // quorum of 1, so this single submission resolves the tick immediately
    // inside submitAction — no separate resolveTick call needed.
    expect(submitted.resolvedNow).toBe(true);

    const rows = await env.DB.prepare(
      `SELECT event_id, target_ids FROM events
       WHERE campaign_id = ?1 AND kind = 'player_action'
         AND EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)`,
    )
      .bind(CAMPAIGN_ID, settlement.id)
      .all<{ event_id: string; target_ids: string }>();
    expect(rows.results).toHaveLength(1);
    const eventId = rows.results![0]!.event_id;

    // Simulate a pre-fix row: this is what every row written before this
    // node landed looks like today.
    await env.DB.prepare("UPDATE events SET target_ids = '[]' WHERE campaign_id = ? AND event_id = ?")
      .bind(CAMPAIGN_ID, eventId)
      .run();
    const stale = await env.DB.prepare(
      "SELECT target_ids FROM events WHERE campaign_id = ? AND event_id = ?",
    )
      .bind(CAMPAIGN_ID, eventId)
      .first<{ target_ids: string }>();
    expect(stale?.target_ids).toBe("[]");

    // reproject() replays the DO's retained `history` — real WorldEvent
    // objects, targetIds included — through the same #writeEvents. This is
    // spec §7's backfill claim, exercised end to end rather than asserted.
    const result = await stub.reproject();
    expect(result.events).toBeGreaterThan(0);

    const repaired = await env.DB.prepare(
      "SELECT target_ids FROM events WHERE campaign_id = ? AND event_id = ?",
    )
      .bind(CAMPAIGN_ID, eventId)
      .first<{ target_ids: string }>();
    expect(JSON.parse(repaired?.target_ids ?? "[]")).toContain(settlement.id);
  });
});
