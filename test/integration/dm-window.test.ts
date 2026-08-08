/**
 * The review window.
 *
 * The property under test is that a tick resolves on the clock while
 * publication waits — and that publication happens exactly once no matter which
 * path gets there first.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, resetDatabase } from "../helpers/schema";
import { setSeat } from "../../src/dm/seat";
import type { Env } from "../../src/env";
import type { WorldState } from "../../src/sim/types";

const env = runtimeEnv as unknown as Env;
const CAMPAIGN = "cmp_win";
const HOST = "plr_host";

/**
 * A fresh Durable Object per test.
 *
 * The workers pool rolls D1 back between tests but *not* Durable Object
 * storage: with one fixed object name the world, the tick counter, and — worse
 * — `phase`/`heldTick` survive into the next test, so a file that passes in
 * order fails when a test is added above it. Naming the object per test makes
 * every case start from a virgin object, which is also what lets the
 * "unset phase reads as open" case below mean anything.
 *
 * The *campaign id* stays fixed, because that is the D1 key the seat lookup
 * uses; only the object's name varies.
 */
let objectName = CAMPAIGN;
let objectSeq = 0;

function stub() {
  return env.CAMPAIGN.get(env.CAMPAIGN.idFromName(objectName));
}

async function seedCampaign(): Promise<void> {
  objectName = `${CAMPAIGN}-${++objectSeq}`;

  // The real migrations, from bare. Cheaper to reason about than a hand-ordered
  // set of DELETEs, and it cannot drift from what production applies.
  await resetDatabase(env.DB);
  await applySchema(env.DB);

  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
    .bind(HOST, "host@example.com", now).run();
  await env.DB.prepare(
    `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
     VALUES (?, 'win', 'Windy Hold', 'weekly', ?, ?)`,
  ).bind(CAMPAIGN, HOST, now).run();

  const campaign = stub();
  await campaign.init({ campaignId: CAMPAIGN, slug: "win", name: "Windy Hold", cadence: "weekly" });
  const joined = await campaign.join(HOST, "Host");
  await env.DB.prepare(
    `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(CAMPAIGN, HOST, joined.characterId, joined.characterName, now).run();
}

async function beatRow(tick: number) {
  return env.DB.prepare(
    "SELECT tick, prose, published_at FROM beats WHERE campaign_id = ? AND tick = ?",
  ).bind(CAMPAIGN, tick).first<{ tick: number; prose: string; published_at: string | null }>();
}

/**
 * The ticks mail actually went out under.
 *
 * `sendBeat` writes one `reply_bindings` row per recipient per send, carrying
 * the tick the reply will be filed against — so this is the only externally
 * visible record of *which turn* a beat was mailed as, and the only way to
 * catch a beat published under the wrong tick number.
 */
async function mailedTicks(): Promise<number[]> {
  const { results } = await env.DB.prepare(
    "SELECT tick FROM reply_bindings WHERE campaign_id = ? ORDER BY tick",
  ).bind(CAMPAIGN).all<{ tick: number }>();
  return results.map((r) => r.tick);
}

/** Fan-out is detached via `waitUntil`, so mail lands after the RPC returns. */
async function settleMail(expected: number): Promise<number[]> {
  for (let i = 0; i < 60; i++) {
    if ((await mailedTicks()).length >= expected) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // A further beat, so a *duplicate* send has time to show up and fail the
  // assertion rather than racing past it.
  await new Promise((r) => setTimeout(r, 250));
  return mailedTicks();
}

describe("review window", () => {
  beforeEach(seedCampaign);

  it("publishes immediately when no DM holds the seat", async () => {
    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(false);
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
  });

  it("holds the beat when a DM holds the seat", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");

    expect(summary.held).toBe(true);
    // Canon advanced — only publication is waiting.
    expect(summary.tick).toBeGreaterThan(0);
    expect((await beatRow(summary.tick))?.published_at).toBeNull();
  });

  it("reports the phase and when the window closes", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");
    const state = await stub().reviewState();

    expect(state.phase).toBe("review");
    expect(state.heldTick).toBe(summary.tick);
    expect(state.windowClosesAt).toBeGreaterThan(Date.now());
  });

  it("publishes on demand and returns to the open phase", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");

    const out = await stub().publishHeldBeat();
    expect(out).toEqual({ published: true, tick: summary.tick });
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
    expect((await stub().reviewState()).phase).toBe("open");
  });

  it("is idempotent — a second publish is a no-op, not a duplicate", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    await stub().resolveTick("manual");

    const first = await stub().publishHeldBeat();
    const second = await stub().publishHeldBeat();
    expect(first.published).toBe(true);
    expect(second).toEqual({ published: false, tick: null });
  });

  it("publishes with no DM seated without error", async () => {
    await stub().resolveTick("manual");
    expect(await stub().publishHeldBeat()).toEqual({ published: false, tick: null });
  });

  it("does not let the review window push the tick deadline out", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const before = Date.now();
    await stub().resolveTick("manual");

    const snapshot = await stub().snapshot();
    const weekMs = 7 * 24 * 3_600_000;
    // The countdown players see is the tick deadline, not the window's end.
    expect(snapshot.deadlineAt).toBeGreaterThan(before + weekMs - 60_000);
    expect(snapshot.deadlineAt).toBeLessThan(before + weekMs + 60_000);
  });

  it("carves even a maximum-length window out of the cycle, not onto it", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    // 56h is `MAX_WINDOW_MS.weekly` — the longest hold this cadence permits,
    // and the case where drift would be most visible.
    const maxWindowMs = 56 * 3_600_000;
    await env.DB.prepare("UPDATE campaigns SET review_window_ms = ? WHERE id = ?")
      .bind(maxWindowMs, CAMPAIGN).run();

    const weekMs = 7 * 24 * 3_600_000;
    const before = Date.now();
    await stub().resolveTick("manual");

    // The alarm is the real clock; `deadlineAt` is only its D1 mirror. Assert
    // on both, or a drifting alarm hides behind a correct-looking countdown.
    const duringReview = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(duringReview).toBeGreaterThan(before + maxWindowMs - 60_000);
    expect(duringReview).toBeLessThan(before + maxWindowMs + 60_000);
    expect((await stub().snapshot()).deadlineAt).toBeGreaterThan(before + weekMs - 60_000);

    await stub().publishHeldBeat();

    // Publication hands the alarm back to the tick clock at the moment it was
    // always going to fire — the window came out of the front of the cycle.
    const afterPublish = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(afterPublish).toBeGreaterThan(before + weekMs - 60_000);
    expect(afterPublish).toBeLessThan(before + weekMs + 60_000);
    expect((await stub().snapshot()).deadlineAt).toBe(afterPublish);
  });

  it("heals a lost review alarm by publishing on the next resolution", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");
    expect((await beatRow(first.tick))?.published_at).toBeNull();

    // The review alarm never fires; the next tick resolves anyway.
    const second = await stub().resolveTick("manual");
    expect((await beatRow(first.tick))?.published_at).not.toBeNull();
    expect(second.tick).toBeGreaterThan(first.tick);
  });

  it("publishes immediately when the window is zero", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    await env.DB.prepare("UPDATE campaigns SET review_window_ms = 0 WHERE id = ?")
      .bind(CAMPAIGN).run();

    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(false);
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
  });

  it("accepts actions during the window but does not resolve on quorum", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");

    // One player is the whole active table here, so this is quorum.
    const out = await stub().submitAction(HOST, "I search the shrine.", "web");
    expect(out.accepted).toBe(true);
    expect(out.resolvedNow).toBe(false);

    const state = await stub().reviewState();
    expect(state.phase).toBe("review");
    expect(state.heldTick).toBe(first.tick);
  });

  it("resolves on quorum again once the beat is published", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    await stub().resolveTick("manual");
    await stub().publishHeldBeat();

    const out = await stub().submitAction(HOST, "I search the shrine.", "web");
    expect(out.resolvedNow).toBe(true);
  });

  it("reads an unset phase as open, exactly like a cleared one", async () => {
    // A campaign that has never resolved a tick has no `phase` key at all.
    // "Never held" and "no longer holding" are the same state to every caller,
    // so they must not be two shapes.
    expect(await stub().reviewState()).toEqual({
      phase: "open",
      heldTick: null,
      windowClosesAt: null,
    });

    await setSeat(env.DB, CAMPAIGN, HOST);
    await stub().resolveTick("manual");
    await stub().publishHeldBeat();

    expect(await stub().reviewState()).toEqual({
      phase: "open",
      heldTick: null,
      windowClosesAt: null,
    });
  });

  it("sends once when four publishes race", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");

    // The review alarm, the DM's button, and the next tick's self-heal can all
    // arrive at once. Exactly one of them may send mail.
    const racers = await Promise.all([
      stub().publishHeldBeat({ expired: true }),
      stub().publishHeldBeat(),
      stub().publishHeldBeat(),
      stub().publishHeldBeat({ expired: true }),
    ]);

    expect(racers.filter((r) => r.published)).toEqual([{ published: true, tick: summary.tick }]);
    expect(await settleMail(1)).toEqual([summary.tick]);
  });

  it("publishes the held beat under its own tick, not the one that healed it", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");

    // The review alarm is lost and the next tick resolves. The healed beat is
    // tick N's prose and must be mailed as tick N: the subject line and the
    // `reply_bindings` row are what a player's reply is filed under, so a beat
    // released under N+1 misfiles every reply to it. Tick N+1 is itself held
    // (the DM is still seated), so exactly one message is owed here.
    const second = await stub().resolveTick("manual");
    expect(second.held).toBe(true);
    expect(await settleMail(1)).toEqual([first.tick]);
  });

  it("publishes immediately when the seat cannot be read", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    // A DM *is* seated, so holding is what a healthy read would produce. Break
    // the read itself: a D1 blip must degrade to today's behavior, never to
    // holding a beat forever behind a lookup that will not answer.
    await env.DB.prepare(
      "ALTER TABLE campaigns RENAME COLUMN dm_player_id TO dm_player_id_unreadable",
    ).run();

    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(false);
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
    expect((await stub().reviewState()).phase).toBe("open");
  });

  it("publishes a blocked beat rather than holding one nobody can release", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);

    // Corrupt canon so the tick is rejected. A fractional year fails
    // `checkWorldInvariants` and survives being incremented, so the rejection
    // is the invariant check rather than a crash inside the sim.
    await runInDurableObject(stub(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'world'")
        .toArray()[0]!;
      const world = JSON.parse(row.v) as WorldState;
      world.year += 0.5;
      state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'world'", JSON.stringify(world));
    });

    const summary = await stub().resolveTick("manual");
    expect(summary.source).toBe("blocked");
    expect(summary.held).toBe(false);

    // Nothing sets `phase` on this path, so a NULL `published_at` here would be
    // a beat marked held that no publish path can ever reach.
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
    expect((await stub().reviewState()).phase).toBe("open");
  });
});
