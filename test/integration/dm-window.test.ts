/**
 * The review window.
 *
 * The property under test is that a tick resolves on the clock while
 * publication waits — and that publication happens exactly once no matter which
 * path gets there first.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema, resetDatabase } from "../helpers/schema";
import { getSeat, setSeat } from "../../src/dm/seat";
import type { EmailSendMessage, Env } from "../../src/env";
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
/**
 * Unique per test, and carried in every subject this campaign sends.
 *
 * Mail goes out through `waitUntil`, so a message from the previous test can
 * still be in flight when this one starts recording — and the binding is
 * global, so it lands in *our* array. The name is what tells the two apart.
 */
let campaignName = "Windy Hold";

function stub() {
  return env.CAMPAIGN.get(env.CAMPAIGN.idFromName(objectName));
}

async function seedCampaign(): Promise<void> {
  objectName = `${CAMPAIGN}-${++objectSeq}`;
  campaignName = `Windy Hold ${objectSeq}`;

  // The real migrations, from bare. Cheaper to reason about than a hand-ordered
  // set of DELETEs, and it cannot drift from what production applies.
  await resetDatabase(env.DB);
  await applySchema(env.DB);

  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
    .bind(HOST, "host@example.com", now).run();
  await env.DB.prepare(
    `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
     VALUES (?, 'win', ?, 'weekly', ?, ?)`,
  ).bind(CAMPAIGN, campaignName, HOST, now).run();

  const campaign = stub();
  await campaign.init({ campaignId: CAMPAIGN, slug: "win", name: campaignName, cadence: "weekly" });
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

/**
 * The messages themselves.
 *
 * `reply_bindings` records *that* a beat was mailed and under which tick, but
 * nothing about its contents — so it cannot tell "the DM's rewrite went out"
 * from "narration's draft went out", and it is written by `sendBeat` only after
 * the binding succeeds. Wrapping the binding is the one place both facts are
 * visible. The wrapper calls through, so the real Email Sending binding still
 * validates every message.
 *
 * The Durable Object runs in this isolate and reads the same `env` object, so
 * replacing the binding here reaches it too.
 */
let sent: EmailSendMessage[] = [];
let realEmail: Env["EMAIL"] | null = null;

/**
 * Beat mail that has actually been handed to the binding.
 *
 * Opening a window also mails the DM a notice, and that message is not a beat:
 * it goes out *before* publication and carries no `replyTo`, precisely because
 * a reply to it must not be filed as the turn's action. Counting it here would
 * make "exactly one beat went out" read as two, so the filter is the same
 * structural property the notice is defined by rather than a subject match.
 */
function beatMail(): EmailSendMessage[] {
  return sent.filter((m) => m.replyTo && m.subject.includes(campaignName));
}

async function settleSent(expected: number): Promise<EmailSendMessage[]> {
  for (let i = 0; i < 60; i++) {
    if (beatMail().length >= expected) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 250));
  return beatMail();
}

/** The alarm itself — the real clock, not the D1 mirror players are shown. */
async function alarmAt(): Promise<number | null> {
  return runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
}

/**
 * The tick deadline the object computed when the tick resolved.
 *
 * Read straight out of the object rather than from `snapshot()`: the mirror
 * `deadlineAt` is written *from* this value, so comparing the two would prove
 * nothing about where the alarm actually points.
 */
async function nextDeadlineAt(): Promise<number> {
  return runInDurableObject(stub(), (_i, state) => {
    const row = state.storage.sql
      .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'nextDeadlineAt'")
      .toArray()[0];
    if (!row) throw new Error("no nextDeadlineAt stored");
    return JSON.parse(row.v) as number;
  });
}

/**
 * Wait out a window that has already elapsed, then make sure it is closed.
 *
 * Whether the pool delivers an expired alarm on its own is not this file's
 * property to assert — `runDurableObjectAlarm` covers the handler directly
 * elsewhere. Here the point is only that the window is over, so give the runtime
 * a chance to end it and close it by hand if it did not. `publishHeldBeat` is
 * idempotent, so the fallback is a no-op when the alarm already fired.
 */
async function settlePublished(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await stub().reviewState()).phase === "open") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  await stub().publishHeldBeat({ expired: true });
}

/** Every projection failure recorded for this campaign, oldest first. */
async function failureKinds(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT kind FROM projection_failures WHERE campaign_id = ? ORDER BY created_at, id",
  ).bind(CAMPAIGN).all<{ kind: string }>();
  return results.map((r) => r.kind);
}

describe("review window", () => {
  beforeEach(async () => {
    await seedCampaign();
    sent = [];
    realEmail ??= env.EMAIL;
    const pass = realEmail;
    (env as { EMAIL: Env["EMAIL"] }).EMAIL = {
      send: async (message: EmailSendMessage) => {
        sent.push(message);
        return pass.send(message);
      },
    };
  });

  afterEach(() => {
    if (realEmail) (env as { EMAIL: Env["EMAIL"] }).EMAIL = realEmail;
  });

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
    const duringReview = await alarmAt();
    expect(duringReview).toBeGreaterThan(before + maxWindowMs - 60_000);
    expect(duringReview).toBeLessThan(before + maxWindowMs + 60_000);
    expect((await stub().snapshot()).deadlineAt).toBeGreaterThan(before + weekMs - 60_000);

    const deadline = await nextDeadlineAt();
    await stub().publishHeldBeat();

    // Publication hands the alarm back to the tick clock at the moment it was
    // always going to fire — the window came out of the front of the cycle.
    // Exactly that moment: a band would accept a cycle restarted on publication.
    expect(await alarmAt()).toBe(deadline);
    expect((await stub().snapshot()).deadlineAt).toBe(deadline);
  });

  it("carves an elapsed review window out of the cycle, not onto it", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    // Short enough to sit through. The length does not matter to the property;
    // what matters is that measurable time passes *inside* the window. The
    // maximum-window case above publishes at t≈0, so a re-arm that restarts the
    // cycle at publication is indistinguishable there from one that never
    // moved — which is precisely how a window-length drift could hide.
    await env.DB.prepare("UPDATE campaigns SET review_window_ms = 400 WHERE id = ?")
      .bind(CAMPAIGN).run();

    const before = Date.now();
    const first = await stub().resolveTick("manual");
    expect(first.held).toBe(true);

    const weekMs = 7 * 24 * 3_600_000;
    const deadline = await nextDeadlineAt();
    expect(deadline).toBeGreaterThan(before + weekMs - 5_000);
    expect(deadline).toBeLessThan(before + weekMs + 5_000);

    // Live through the window, then publish however the runtime gets there.
    await new Promise((r) => setTimeout(r, 500));
    await settlePublished();

    // The deadline is absolute from the moment the tick resolved, so the
    // re-armed alarm is that number and not a number near it. Half a second of
    // drift is the same bug as six days of it, and only exact equality says so.
    expect(await alarmAt()).toBe(deadline);
    expect((await stub().snapshot()).deadlineAt).toBe(deadline);
    expect((await beatRow(first.tick))?.published_at).not.toBeNull();
  });

  it("ends the window when the alarm fires, rather than resolving another tick", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");
    expect(first.held).toBe(true);
    const deadline = await nextDeadlineAt();

    // The alarm means two different things depending on the phase, and until
    // now nothing in the suite ever fired it — a handler that always resolved a
    // tick left the whole file green while making every cycle fire a window
    // early. This runs the real `alarm()` through the runtime.
    expect(await runDurableObjectAlarm(stub())).toBe(true);

    // In `review` the alarm ends the *window*. Canon must not move: the beat
    // players are about to read is still the newest thing that happened.
    expect((await stub().snapshot()).tick).toBe(first.tick);
    expect((await stub().reviewState())).toEqual({
      phase: "open",
      heldTick: null,
      windowClosesAt: null,
    });
    expect((await beatRow(first.tick))?.published_at).not.toBeNull();
    expect(await settleMail(1)).toEqual([first.tick]);

    // And the alarm goes back to being the tick clock, at the original deadline.
    expect(await alarmAt()).toBe(deadline);
  });

  it("resolves the tick when the alarm fires outside a window", async () => {
    // The other half of the same branch: with no DM seated the alarm is the
    // tick clock and must still advance canon.
    const before = await stub().snapshot();
    expect(await runDurableObjectAlarm(stub())).toBe(true);

    const after = await stub().snapshot();
    expect(after.tick).toBe(before.tick + 1);
    expect((await beatRow(after.tick))?.published_at).not.toBeNull();
  });

  it("re-arms and still mails when the beat cannot be read back", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");
    const deadline = await nextDeadlineAt();

    // The read model goes away mid-window. That read sits *after* the phase has
    // been claimed, so a throw there would clear `phase`/`heldTick` and then
    // strand the beat: no path reaches a beat that is no longer in `review`.
    await env.DB.prepare("ALTER TABLE beats RENAME TO beats_unreadable").run();

    // Nothing may escape. From `alarm()` an escaping throw is retried into an
    // early resolve; from the host's resolve route it wedges the tick outright.
    const out = await stub().publishHeldBeat({ expired: true });
    expect(out).toEqual({ published: true, tick: first.tick });
    expect((await stub().reviewState()).phase).toBe("open");

    // The alarm is back on the tick clock rather than left on a window that
    // closed — which on a weekly cadence points six days into the past.
    expect(await alarmAt()).toBe(deadline);

    // The table still gets its beat, from the copy the object kept.
    const mail = await settleSent(1);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain(`Tick ${first.tick}`);

    // And the drift is a row somebody can find and repair.
    expect(await failureKinds()).toContain("publish-read");
  });

  it("mails the held beat when its row has been deleted", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");
    const narrated = (await beatRow(first.tick))!.prose;

    await env.DB.prepare("DELETE FROM beats WHERE campaign_id = ? AND tick = ?")
      .bind(CAMPAIGN, first.tick).run();

    // `published: true` has to mean somebody got mail. A recoverable read-model
    // failure that quietly consumes a turn is worse than the outage it hides.
    const out = await stub().publishHeldBeat();
    expect(out).toEqual({ published: true, tick: first.tick });

    const mail = await settleSent(1);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain(narrated);
    expect(await failureKinds()).toContain("publish-read");
  });

  it("publishes the DM's rewrite, not the prose narration produced", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");
    const narrated = (await beatRow(first.tick))!.prose;

    // The whole reason the row is read back at publication. The object's copy
    // is a fallback for a missing row, never a preference over a present one.
    const rewritten = "The gate stood open, and nobody would say who had opened it.";
    await env.DB.prepare("UPDATE beats SET prose = ? WHERE campaign_id = ? AND tick = ?")
      .bind(rewritten, CAMPAIGN, first.tick).run();

    await stub().publishHeldBeat();

    const mail = await settleSent(1);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain(rewritten);
    expect(mail[0]!.text).not.toContain(narrated);
    expect(await failureKinds()).toEqual([]);
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

  it("sends once even when the racers interleave inside the object", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");

    // Four separate RPCs are not a hard enough race: something ahead of the
    // method serialises them, so moving the phase claim behind a D1 round-trip
    // — the exact yield a future edit would introduce — leaves that test green.
    // Calling the instance directly puts all four inside one context, where the
    // first `await` really does hand control to the next caller. No sleeps: the
    // interleaving is structural, so this cannot go flaky on a slow machine.
    const racers = await runInDurableObject(stub(), (instance) =>
      Promise.all([
        instance.publishHeldBeat({ expired: true }),
        instance.publishHeldBeat(),
        instance.publishHeldBeat(),
        instance.publishHeldBeat({ expired: true }),
      ]),
    );

    expect(racers.filter((r) => r.published)).toEqual([{ published: true, tick: summary.tick }]);
    expect(await settleMail(1)).toEqual([summary.tick]);
    expect(await settleSent(1)).toHaveLength(1);
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

  it("still holds the beat when the DM notice cannot be sent", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    // The plan reached this state by pointing the seat at a nonexistent player,
    // which the real migrations reject outright — `dm_player_id REFERENCES
    // players(id)`. Breaking the send itself is the same failure and a truer
    // one: mail is the dependency that must never be able to cost a turn.
    (env as { EMAIL: Env["EMAIL"] }).EMAIL = {
      send: async () => {
        throw new Error("mail is down");
      },
    };

    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(true);
    expect((await stub().reviewState()).phase).toBe("review");
  });

  describe("a DM who stops showing up", () => {
    async function missed(): Promise<number> {
      const row = await env.DB.prepare(
        "SELECT dm_missed_windows FROM campaigns WHERE id = ?",
      ).bind(CAMPAIGN).first<{ dm_missed_windows: number }>();
      return row?.dm_missed_windows ?? 0;
    }

    async function seatHolder(): Promise<string | null> {
      const row = await env.DB.prepare(
        "SELECT dm_player_id FROM campaigns WHERE id = ?",
      ).bind(CAMPAIGN).first<{ dm_player_id: string | null }>();
      return row?.dm_player_id ?? null;
    }

    beforeEach(async () => {
      // Foreign keys are live in this fixture, so the player row has to exist
      // before either the seat column or the membership can reference it.
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT OR IGNORE INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind("plr_dm", "dm@example.com", now).run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO memberships
           (campaign_id, player_id, character_id, character_name, joined_at)
         VALUES (?, 'plr_dm', 'chr_dm', 'Dee', ?)`,
      ).bind(CAMPAIGN, now).run();
      await setSeat(env.DB, CAMPAIGN, "plr_dm");
    });

    it("counts a window that expired untouched", async () => {
      await stub().resolveTick("manual");
      await stub().publishHeldBeat({ expired: true });
      expect(await missed()).toBe(1);
    });

    it("resets the count when the DM publishes themselves", async () => {
      await stub().resolveTick("manual");
      await stub().publishHeldBeat({ expired: true });
      await stub().resolveTick("manual");
      await stub().publishHeldBeat();
      expect(await missed()).toBe(0);
    });

    it("reverts the seat to the host after three", async () => {
      for (let i = 0; i < 3; i++) {
        await stub().resolveTick("manual");
        await stub().publishHeldBeat({ expired: true });
      }
      expect(await seatHolder()).toBe(HOST);
      // Reverting is a fresh start for whoever holds it now.
      expect(await missed()).toBe(0);
    });

    it("does not revert at two", async () => {
      for (let i = 0; i < 2; i++) {
        await stub().resolveTick("manual");
        await stub().publishHeldBeat({ expired: true });
      }
      expect(await seatHolder()).toBe("plr_dm");
    });

    it("counts a window the next tick had to close on the DM's behalf", async () => {
      // The self-heal path: the review alarm is lost, so the following
      // resolution publishes the stranded beat with `expired: true`. That is
      // the same silence as an expired window and must cost the same.
      await stub().resolveTick("manual");
      await stub().resolveTick("manual");
      expect(await missed()).toBe(1);
    });

    it("counts three the same whichever path closed each window", async () => {
      // Key normalisation, in the sense that matters here: "three consecutive
      // silent windows" is one state. It must not depend on whether the alarm,
      // the next tick, or a manual expiry got there — otherwise a campaign that
      // lost an alarm keeps its DM forever.
      await stub().resolveTick("manual");
      await stub().publishHeldBeat({ expired: true });
      await stub().resolveTick("manual");
      await stub().resolveTick("manual"); // self-heal closes window two
      expect(await runDurableObjectAlarm(stub())).toBe(true); // the alarm closes three
      await settlePublished();

      expect(await seatHolder()).toBe(HOST);
      expect(await missed()).toBe(0);
    });

    it("does not count a window the DM spent rewriting the beat", async () => {
      // The spec's word is "untouched" (docs/specs §3), not "unpublished". A DM
      // who rewrote the prose and let the clock send it was present, and taking
      // their seat away for that would be a bug wearing a policy's clothes.
      const first = await stub().resolveTick("manual");
      await env.DB.prepare(
        "UPDATE beats SET prose = ?, original_prose = prose, revised_by = 'plr_dm' " +
          "WHERE campaign_id = ? AND tick = ?",
      ).bind("The ford ran high, and nobody crossed.", CAMPAIGN, first.tick).run();

      await stub().publishHeldBeat({ expired: true });
      expect(await missed()).toBe(0);
    });

    it("stops counting once the seat is vacated mid-window", async () => {
      await stub().resolveTick("manual");
      await setSeat(env.DB, CAMPAIGN, null);
      await stub().publishHeldBeat({ expired: true });
      expect(await missed()).toBe(0);
      expect(await seatHolder()).toBeNull();
    });

    it("charges one window once, however many callers close it", async () => {
      // The review alarm, the DM's button and the next tick's self-heal can all
      // arrive together. Exactly one of them publishes, so exactly one of them
      // may count — a window charged twice reverts the seat a third early.
      await stub().resolveTick("manual");
      await runInDurableObject(stub(), (instance) =>
        Promise.all([
          instance.publishHeldBeat({ expired: true }),
          instance.publishHeldBeat({ expired: true }),
          instance.publishHeldBeat({ expired: true }),
          instance.publishHeldBeat({ expired: true }),
        ]),
      );
      expect(await missed()).toBe(1);
    });

    it("counts two windows that close at the same moment as two", async () => {
      // The other direction, and the one a read-then-write counter loses: two
      // windows in flight at once both read the old number before either
      // writes, so three silences record as two and the seat never moves.
      await stub().resolveTick("manual");
      await stub().publishHeldBeat({ expired: true });
      await stub().resolveTick("manual");
      await runInDurableObject(stub(), (instance) =>
        Promise.all([
          instance.publishHeldBeat({ expired: true }),
          instance.publishHeldBeat({ expired: true }),
        ]),
      );
      expect(await missed()).toBe(2);
    });

    it("publishes anyway when the seat bookkeeping cannot be written", async () => {
      // Accounting is not worth a turn. If the counter cannot be read or
      // written, the beat still goes out and the alarm still goes back to the
      // tick clock.
      const first = await stub().resolveTick("manual");
      const deadline = await nextDeadlineAt();
      await env.DB.prepare(
        "ALTER TABLE campaigns RENAME COLUMN dm_missed_windows TO dm_missed_windows_unreadable",
      ).run();

      expect(await stub().publishHeldBeat({ expired: true }))
        .toEqual({ published: true, tick: first.tick });
      expect((await stub().reviewState()).phase).toBe("open");
      expect(await alarmAt()).toBe(deadline);
    });
  });

  describe("a beat the DM rewrote", () => {
    /**
     * Re-run the tick the object has already resolved.
     *
     * Rewinding the stored world to its pre-tick clone is the only way to make
     * `#project` write the *same* `(campaign_id, tick)` twice, which is the
     * conflict its `ON CONFLICT` clause exists for. Nothing else in the app
     * reaches that branch today, and "nothing reaches it today" is exactly how
     * a clause that silently discards a DM's work survives review.
     */
    async function reresolve(before: WorldState): Promise<void> {
      await runInDurableObject(stub(), (_instance, state) => {
        state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'world'", JSON.stringify(before));
      });
      await stub().resolveTick("manual");
    }

    it("keeps the DM's prose when the tick is projected again", async () => {
      const before = await stub().debugWorld();
      const first = await stub().resolveTick("manual");

      const rewritten = "The gate stood open, and nobody would say who had opened it.";
      await env.DB.prepare(
        "UPDATE beats SET prose = ?, original_prose = prose, revised_by = ? " +
          "WHERE campaign_id = ? AND tick = ?",
      ).bind(rewritten, HOST, CAMPAIGN, first.tick).run();

      await reresolve(before);
      expect((await beatRow(first.tick))?.prose).toBe(rewritten);
    });

    it("still repairs an unrevised beat", async () => {
      // The other half: the guard must protect a rewrite, not freeze the row.
      const before = await stub().debugWorld();
      const first = await stub().resolveTick("manual");
      await env.DB.prepare("UPDATE beats SET prose = 'STALE' WHERE campaign_id = ? AND tick = ?")
        .bind(CAMPAIGN, first.tick).run();

      await reresolve(before);
      expect((await beatRow(first.tick))?.prose).not.toBe("STALE");
    });

    it("survives a chronicle rebuild", async () => {
      const first = await stub().resolveTick("manual");
      const rewritten = "Nobody spoke on the walk back.";
      await env.DB.prepare(
        "UPDATE beats SET prose = ?, original_prose = prose, revised_by = ? " +
          "WHERE campaign_id = ? AND tick = ?",
      ).bind(rewritten, HOST, CAMPAIGN, first.tick).run();

      await stub().reproject();
      expect((await beatRow(first.tick))?.prose).toBe(rewritten);
    });
  });

  describe("what a held turn shows in the app", () => {
    const OTHER = "plr_two";

    beforeEach(async () => {
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT OR IGNORE INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind(OTHER, "two@example.com", now).run();
      const joined = await stub().join(OTHER, "Two");
      await env.DB.prepare(
        `INSERT OR IGNORE INTO memberships
           (campaign_id, player_id, character_id, character_name, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(CAMPAIGN, OTHER, joined.characterId, joined.characterName, now).run();
      await setSeat(env.DB, CAMPAIGN, HOST);
    });

    it("does not leak the outcome to a member while the beat is held", async () => {
      const beforeSituation = (await stub().snapshot()).situation;
      await stub().resolveTick("manual");
      const resolved = (await stub().debugWorld()).scene.situation;
      // If the tick did not move the scene line there is nothing to leak and
      // this file would be asserting nothing at all.
      expect(resolved).not.toBe(beforeSituation);

      // The scene line advances at resolution, but a player who has not read
      // the beat must still be looking at the world they last saw.
      expect((await stub().snapshot(OTHER)).situation).toBe(beforeSituation);
    });

    it("shows the DM the turn they are being asked to judge", async () => {
      const beforeSituation = (await stub().snapshot()).situation;
      await stub().resolveTick("manual");
      const resolved = (await stub().debugWorld()).scene.situation;

      expect((await stub().snapshot(HOST)).situation).toBe(resolved);
      expect((await stub().snapshot(HOST)).situation).not.toBe(beforeSituation);
    });

    it("shows everyone the new scene once the beat publishes", async () => {
      await stub().resolveTick("manual");
      await stub().publishHeldBeat();
      const resolved = (await stub().debugWorld()).scene.situation;

      expect((await stub().snapshot(OTHER)).situation).toBe(resolved);
      expect((await stub().snapshot(HOST)).situation).toBe(resolved);
      expect((await stub().snapshot()).situation).toBe(resolved);
    });

    it("masks the scene for a caller that names no viewer", async () => {
      // `snapshot()`'s viewer is optional, so "nobody named" is a state the
      // contract has to answer for in its own right: it means "assume the
      // least privilege", never "assume the DM". Which callers omit the
      // argument is deliberately not pinned here — that set changes, and the
      // default has to stay safe for whatever is in it.
      const beforeSituation = (await stub().snapshot()).situation;
      await stub().resolveTick("manual");
      expect((await stub().snapshot()).situation).toBe(beforeSituation);
    });

    it("masks the scene when the seat cannot be read", async () => {
      const beforeSituation = (await stub().snapshot()).situation;
      await stub().resolveTick("manual");
      await env.DB.prepare(
        "ALTER TABLE campaigns RENAME COLUMN dm_player_id TO dm_player_id_unreadable",
      ).run();
      // A lookup that will not answer cannot be a reason to show the DM's view
      // to everybody.
      expect((await stub().snapshot(HOST)).situation).toBe(beforeSituation);
    });

    it("does not hold a stale scene past the window", async () => {
      // The mask is keyed on the phase, so a cleared phase must clear it too —
      // otherwise a campaign shows last turn's scene forever.
      await stub().resolveTick("manual");
      await stub().publishHeldBeat();
      const afterFirst = (await stub().snapshot(OTHER)).situation;

      await stub().resolveTick("manual");
      await stub().publishHeldBeat();
      expect((await stub().snapshot(OTHER)).situation).not.toBe(afterFirst);
    });
  });

  describe("handing the seat on", () => {
    it("does not give an incoming DM the outgoing DM's window", async () => {
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT OR IGNORE INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind("plr_dm", "dm@example.com", now).run();

      await setSeat(env.DB, CAMPAIGN, HOST);
      // "Never hold" is the outgoing DM's preference, and it is the one setting
      // whose inheritance is invisible: the new DM gets no window, no notice,
      // and nothing to tell them why.
      await env.DB.prepare("UPDATE campaigns SET review_window_ms = 0 WHERE id = ?")
        .bind(CAMPAIGN).run();

      await setSeat(env.DB, CAMPAIGN, "plr_dm");
      expect((await getSeat(env.DB, CAMPAIGN))?.reviewWindowMs).toBeNull();

      const summary = await stub().resolveTick("manual");
      expect(summary.held).toBe(true);
    });

    it("gives a reverted host a clean slate, window included", async () => {
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT OR IGNORE INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind("plr_dm", "dm@example.com", now).run();
      await setSeat(env.DB, CAMPAIGN, "plr_dm");
      // Long enough that the review alarm cannot fire inside this test: the
      // three windows are closed by the explicit calls below, so what is being
      // asserted is the reset, not a race with the clock.
      await env.DB.prepare("UPDATE campaigns SET review_window_ms = 60000 WHERE id = ?")
        .bind(CAMPAIGN).run();

      for (let i = 0; i < 3; i++) {
        await stub().resolveTick("manual");
        await stub().publishHeldBeat({ expired: true });
      }

      const seat = await getSeat(env.DB, CAMPAIGN);
      expect(seat).toEqual({ dmPlayerId: HOST, reviewWindowMs: null, missedWindows: 0 });
    });
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
