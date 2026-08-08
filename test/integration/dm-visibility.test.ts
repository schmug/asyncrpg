/**
 * A held beat must not leak before the DM publishes it — not to the public
 * chronicle, not to another member's app, not to a logged-out reader.
 *
 * The DM is the one exception: they cannot review what they cannot see.
 *
 * Three readers are exercised against every read path, because "held" is not a
 * property of the beat, it is a property of the beat *and who is asking*:
 * logged out, a member who does not hold the seat, and the DM.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, resetDatabase } from "../helpers/schema";
import { mintSessionForTest } from "../helpers/session";
import { setSeat } from "../../src/dm/seat";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const SLUG = "vis";
const DM = "plr_dm";
const PLAYER = "plr_player";
const OUTSIDER = "plr_outsider";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/**
 * A fresh Durable Object per test.
 *
 * Neither D1 nor Durable Object storage is isolated between tests in this pool
 * — `vitest.config.ts` sets no `isolatedStorage`, so both persist and both must
 * be reset explicitly. `seed()` handles D1 via `resetDatabase`; for the object,
 * the router names it from `campaigns.id`, so — unlike a test that builds the
 * stub itself — the only way to get a virgin one through `worker.fetch` is to
 * vary the campaign id. The *slug* stays fixed, because that is what the URLs
 * in these tests say.
 */
let campaignId = "cmp_vis";
let seq = 0;

async function get(path: string, playerId?: string): Promise<Response> {
  const headers = new Headers();
  if (playerId) headers.set("cookie", await mintSessionForTest(env, playerId));
  return worker.fetch!(new Request(`https://example.com${path}`, { headers }), env, ctx);
}

async function seed(): Promise<void> {
  campaignId = `cmp_vis_${++seq}`;

  // The real migrations, from bare: foreign keys and CHECKs are enforced here
  // exactly as production enforces them, so parents are seeded before children.
  await resetDatabase(env.DB);
  await applySchema(env.DB);

  const now = new Date().toISOString();
  for (const [id, email] of [
    [DM, "dm@example.com"],
    [PLAYER, "p@example.com"],
    [OUTSIDER, "out@example.com"],
  ]) {
    await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
      .bind(id, email, now)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
     VALUES (?, ?, 'Vista', 'weekly', ?, ?)`,
  )
    .bind(campaignId, SLUG, DM, now)
    .run();

  // The campaign GET reaches into the object for the snapshot and the prompt,
  // so the object has to be a real initialised campaign, not an empty one.
  const stub = env.CAMPAIGN.get(env.CAMPAIGN.idFromName(campaignId));
  await stub.init({ campaignId, slug: SLUG, name: "Vista", cadence: "weekly" });
  for (const [id, name] of [
    [DM, "Dee"],
    [PLAYER, "Pat"],
  ]) {
    const joined = await stub.join(id!, name!);
    await env.DB.prepare(
      `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(campaignId, id, joined.characterId, joined.characterName, now)
      .run();
  }
  await setSeat(env.DB, campaignId, DM);

  // Tick 1 published, tick 2 held.
  await env.DB.prepare(
    `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
     VALUES (?, 1, 'The published beat.', 's', 'model', ?, ?)`,
  )
    .bind(campaignId, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
     VALUES (?, 2, 'The held beat.', 's', 'model', ?, NULL)`,
  )
    .bind(campaignId, now)
    .run();

  // The simulation writes events at resolution, not at publication, so the
  // timeline is a second way the held turn could escape.
  await env.DB.prepare(
    `INSERT INTO events (campaign_id, event_id, tick, kind, summary, significance, created_at)
     VALUES (?, 'ev1', 1, 'battle', 'The published turning point.', 80, ?)`,
  )
    .bind(campaignId, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO events (campaign_id, event_id, tick, kind, summary, significance, created_at)
     VALUES (?, 'ev2', 2, 'battle', 'The held turning point.', 80, ?)`,
  )
    .bind(campaignId, now)
    .run();
}

async function publishTick2(): Promise<void> {
  await env.DB.prepare("UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = 2")
    .bind(new Date().toISOString(), campaignId)
    .run();
}

describe("held beat visibility", () => {
  beforeEach(seed);

  describe("the public chronicle", () => {
    it("hides the held beat from a logged-out reader", async () => {
      const res = await get(`/c/${SLUG}`);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain("The published beat.");
      expect(body).not.toContain("The held beat.");
    });

    it("hides the held beat from a member who does not hold the seat", async () => {
      const body = await (await get(`/c/${SLUG}`, PLAYER)).text();
      expect(body).toContain("The published beat.");
      expect(body).not.toContain("The held beat.");
    });

    it("shows the held beat to the DM, marked as held", async () => {
      const body = await (await get(`/c/${SLUG}`, DM)).text();
      expect(body).toContain("The held beat.");
      expect(body).toContain("held for review");
    });

    it("does not extend the DM exception to a seat holder who is not a member", async () => {
      // No code path produces this state — `setSeat` is the only writer of
      // `dm_player_id` and it checks membership. That is exactly why the state
      // has to be forced here: the chronicle must not depend on an invariant
      // enforced in a different file. The `/dm/` endpoints stopped trusting the
      // seat alone; this is the same property on the read path, which is the
      // one that renders held prose to the open internet.
      await env.DB.prepare("UPDATE campaigns SET dm_player_id = ? WHERE id = ?")
        .bind(OUTSIDER, campaignId)
        .run();

      const body = await (await get(`/c/${SLUG}`, OUTSIDER)).text();
      expect(body).toContain("The published beat.");
      expect(body).not.toContain("The held beat.");
      expect(body).not.toContain("held for review");
      expect(body).not.toContain("The held turning point.");
    });

    it("counts only published turns for everyone but the DM", async () => {
      expect(await (await get(`/c/${SLUG}`)).text()).toContain("1 recorded turn.");
      expect(await (await get(`/c/${SLUG}`, DM)).text()).toContain("2 recorded turns.");
    });

    it("keeps the held turn out of the timeline too", async () => {
      const anon = await (await get(`/c/${SLUG}`)).text();
      expect(anon).toContain("The published turning point.");
      expect(anon).not.toContain("The held turning point.");

      const member = await (await get(`/c/${SLUG}`, PLAYER)).text();
      expect(member).not.toContain("The held turning point.");

      expect(await (await get(`/c/${SLUG}`, DM)).text()).toContain("The held turning point.");
    });

    it("keeps events visible at a tick whose beat never projected", async () => {
      // The timeline filter is deliberately "there is a beat and it is held"
      // rather than the simpler-reading "there is a published beat". A tick
      // whose narration failed to project has no beat row at all, so under the
      // positive form its events match nothing and vanish — not from the held
      // turn, from every chronicle in the install, retroactively and silently.
      // This is the test that makes the double negative load-bearing.
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO events (campaign_id, event_id, tick, kind, summary, significance, created_at)
         VALUES (?, 'ev_orphan', 3, 'battle', 'ORPHAN_TICK_EVENT', 80, ?)`,
      )
        .bind(campaignId, now)
        .run();

      // The premise, asserted rather than assumed: tick 3 has no beat at all.
      const beats = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM beats WHERE campaign_id = ? AND tick = 3",
      )
        .bind(campaignId)
        .first<{ n: number }>();
      expect(beats?.n).toBe(0);

      expect(await (await get(`/c/${SLUG}`)).text()).toContain("ORPHAN_TICK_EVENT");
      expect(await (await get(`/c/${SLUG}`, PLAYER)).text()).toContain("ORPHAN_TICK_EVENT");
    });

    it("never lets a personalised chronicle into a shared cache", async () => {
      // The DM's copy carries a beat nobody else may see. Served under the
      // anonymous page's `public, max-age=60` a shared cache would hand it to
      // the next reader, which would leak the held beat without any read path
      // being wrong.
      const dm = await get(`/c/${SLUG}`, DM);
      expect(dm.headers.get("cache-control")).toBe("private, no-store");

      const anon = await get(`/c/${SLUG}`);
      expect(anon.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("shows the beat and its turning point to everyone once published", async () => {
      await publishTick2();
      const body = await (await get(`/c/${SLUG}`)).text();
      expect(body).toContain("The held beat.");
      expect(body).toContain("The held turning point.");
      expect(body).not.toContain("held for review");
    });
  });

  describe("the campaign GET", () => {
    it("gives a member who does not hold the seat the last published beat", async () => {
      const body = await (await get(`/api/campaigns/${SLUG}`, PLAYER)).json<{
        latestBeat: { tick: number; prose: string; held?: boolean } | null;
      }>();
      expect(body.latestBeat?.tick).toBe(1);
      expect(body.latestBeat?.prose).toBe("The published beat.");
      expect(body.latestBeat?.held).toBe(false);
    });

    it("shows the held beat to the DM, flagged as held", async () => {
      const body = await (await get(`/api/campaigns/${SLUG}`, DM)).json<{
        latestBeat: { tick: number; prose: string; held?: boolean } | null;
      }>();
      expect(body.latestBeat?.tick).toBe(2);
      expect(body.latestBeat?.prose).toBe("The held beat.");
      expect(body.latestBeat?.held).toBe(true);
    });

    it("tells a logged-out caller to sign in rather than answering", async () => {
      const res = await get(`/api/campaigns/${SLUG}`);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("The held beat.");
    });

    it("refuses a signed-in non-member", async () => {
      const res = await get(`/api/campaigns/${SLUG}`, OUTSIDER);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("The held beat.");
    });

    it("shows the beat to everyone once published", async () => {
      await publishTick2();
      const body = await (await get(`/api/campaigns/${SLUG}`, PLAYER)).json<{
        latestBeat: { tick: number; held?: boolean } | null;
      }>();
      expect(body.latestBeat?.tick).toBe(2);
      expect(body.latestBeat?.held).toBe(false);
    });

    it("falls back to the previous published beat, not to nothing", async () => {
      // A member whose newest beat is held still has a story to read.
      const body = await (await get(`/api/campaigns/${SLUG}`, PLAYER)).json<{
        latestBeat: { tick: number } | null;
      }>();
      expect(body.latestBeat).not.toBeNull();
      expect(body.latestBeat?.tick).toBe(1);
    });

    it("reports no beat at all when every beat is held", async () => {
      await env.DB.prepare("UPDATE beats SET published_at = NULL WHERE campaign_id = ?")
        .bind(campaignId)
        .run();
      const body = await (await get(`/api/campaigns/${SLUG}`, PLAYER)).json<{
        latestBeat: unknown;
      }>();
      expect(body.latestBeat).toBeNull();
    });
  });

  describe("the exception is scoped to the campaign", () => {
    it("does not let the DM of one campaign see another's held beat", async () => {
      // `getSeat` is keyed by campaign, and this is the test that says so.
      // A single global "is a DM" notion would open every held beat in the
      // system to anyone holding any seat anywhere.
      const now = new Date().toISOString();
      const other = `${campaignId}_other`;
      await env.DB.prepare(
        `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
         VALUES (?, 'other', 'Other', 'weekly', ?, ?)`,
      )
        .bind(other, PLAYER, now)
        .run();
      await env.DB.prepare(
        `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
         VALUES (?, 1, 'Another held beat.', 's', 'model', ?, NULL)`,
      )
        .bind(other, now)
        .run();

      // DM holds the seat in the first campaign, and nothing in this one.
      const body = await (await get(`/c/other`, DM)).text();
      expect(body).not.toContain("Another held beat.");
    });

    it("does not let a held beat in one campaign blank another's timeline", async () => {
      // The timeline's held-check is a *correlated* subquery, and the
      // correlation on `campaign_id` is the whole of what keeps it local. Tick
      // numbers are per-campaign counters, so a collision between two
      // campaigns' tick 1 is the ordinary case, not an exotic one — drop the
      // correlation and one campaign holding a beat blanks that tick from
      // every other campaign's chronicle in the install.
      const now = new Date().toISOString();
      const other = `${campaignId}_held`;

      // Campaign A's tick 1 is published, so its turning point is public.
      await env.DB.prepare(
        `INSERT INTO events (campaign_id, event_id, tick, kind, summary, significance, created_at)
         VALUES (?, 'ev_a', 1, 'battle', 'CAMPAIGN_A_TURNING_POINT', 80, ?)`,
      )
        .bind(campaignId, now)
        .run();

      // Campaign B is holding a beat at the same tick number.
      await env.DB.prepare(
        `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
         VALUES (?, 'held-elsewhere', 'Elsewhere', 'weekly', ?, ?)`,
      )
        .bind(other, PLAYER, now)
        .run();
      await env.DB.prepare(
        `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
         VALUES (?, 1, 'B is holding this.', 's', 'model', ?, NULL)`,
      )
        .bind(other, now)
        .run();

      const page = await (await get(`/c/${SLUG}`)).text();
      expect(page).toContain("CAMPAIGN_A_TURNING_POINT");
      expect(page).not.toContain("B is holding this.");
    });
  });

  describe("when the seat is empty", () => {
    it("hides a held beat from the former DM as well", async () => {
      // The exception follows the seat, not the person who used to sit in it.
      await setSeat(env.DB, campaignId, null);
      const body = await (await get(`/api/campaigns/${SLUG}`, DM)).json<{
        latestBeat: { tick: number } | null;
      }>();
      expect(body.latestBeat?.tick).toBe(1);
      expect(await (await get(`/c/${SLUG}`, DM)).text()).not.toContain("The held beat.");
    });
  });
});
