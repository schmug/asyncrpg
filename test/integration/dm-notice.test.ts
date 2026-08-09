/**
 * The held-beat notice.
 *
 * A window the DM never hears about is just latency. This asserts the notice is
 * composed and addressed correctly, and — importantly — that a send failure
 * does not take the tick down with it.
 *
 * The fixture runs the real migrations, so foreign keys bite: `players` before
 * `campaigns` before `memberships`. Durable Object storage is not rolled back
 * between tests in this pool either, so every test names its own object.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema, resetDatabase } from "../helpers/schema";
import { setSeat } from "../../src/dm/seat";
import { reviewNoticeBody, reviewNoticeSubject } from "../../src/email/outbound";
import type { EmailSendMessage, Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const CAMPAIGN = "cmp_notice";
const HOST = "plr_host";
const DM = "plr_dm";

let objectName = CAMPAIGN;
let objectSeq = 0;
/**
 * Unique per test, and carried in every subject this campaign sends.
 *
 * Mail goes out through `waitUntil`, so a message from the previous test can
 * still be in flight when this one starts recording — and the binding is
 * global, so it lands in *our* array. Nothing about a generic "Windy Hold"
 * message says which test it belongs to, which is how a shuffled run turns a
 * length assertion red. The name is the discriminator.
 */
let campaignName = "Windy Hold";

function stub() {
  return env.CAMPAIGN.get(env.CAMPAIGN.idFromName(objectName));
}

let sent: EmailSendMessage[] = [];
let realEmail: Env["EMAIL"] | null = null;

/** Mail this test's campaign sent, ignoring anything still draining. */
function mine(): EmailSendMessage[] {
  return sent.filter((m) => m.subject.includes(campaignName));
}

/** Mail is fanned out through `waitUntil`, so it lands after the RPC returns. */
async function settleSent(expected: number): Promise<EmailSendMessage[]> {
  for (let i = 0; i < 60; i++) {
    if (mine().length >= expected) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // A further beat, so a *duplicate* has time to show up and fail an assertion
  // rather than racing past it.
  await new Promise((r) => setTimeout(r, 250));
  return mine();
}

async function seedCampaign(): Promise<void> {
  objectName = `${CAMPAIGN}-${++objectSeq}`;
  campaignName = `Windy Hold ${objectSeq}`;
  await resetDatabase(env.DB);
  await applySchema(env.DB);

  const now = new Date().toISOString();
  for (const [id, email] of [
    [HOST, "host@asyncrpg-fixtures.dev"],
    [DM, "dee@asyncrpg-fixtures.dev"],
  ]) {
    await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
      .bind(id, email, now).run();
  }
  await env.DB.prepare(
    `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
     VALUES (?, 'notice', ?, 'weekly', ?, ?)`,
  ).bind(CAMPAIGN, campaignName, HOST, now).run();

  const campaign = stub();
  await campaign.init({ campaignId: CAMPAIGN, slug: "notice", name: campaignName, cadence: "weekly" });
  const joined = await campaign.join(HOST, "Host");
  await env.DB.prepare(
    `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(CAMPAIGN, HOST, joined.characterId, joined.characterName, now).run();
  await env.DB.prepare(
    `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
     VALUES (?, ?, 'chr_dm', 'Dee', ?)`,
  ).bind(CAMPAIGN, DM, now).run();
}

describe("review notice", () => {
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

  describe("composition", () => {
    const body = () =>
      reviewNoticeBody({
        campaignName: "Windy Hold",
        campaignSlug: "win",
        tick: 7,
        prose: "The ford ran high.",
        closesAt: Date.parse("2026-08-09T12:00:00Z"),
        origin: "https://play.example.com",
      });

    it("names the campaign and the turn in the subject", () => {
      const subject = reviewNoticeSubject("Windy Hold", 7);
      expect(subject).toContain("Windy Hold");
      expect(subject).toContain("7");
    });

    it("includes the prose so the DM can judge it without opening the app", () => {
      expect(body()).toContain("The ford ran high.");
      expect(body()).toContain("https://play.example.com");
    });

    it("says what happens if the DM does nothing", () => {
      // The promise the whole design rests on: silence is safe.
      expect(body().toLowerCase()).toMatch(/publish(es)? (on its own|automatically)|by itself/);
    });

    it("says when the window closes", () => {
      expect(body()).toContain(new Date(Date.parse("2026-08-09T12:00:00Z")).toUTCString());
    });

    it("links somewhere the app can actually route to", () => {
      // This shipped broken: the notice pointed at `#/c/<slug>/review`, and the
      // client router matches `#/c/<slug>` exactly, so the one link in the one
      // email this feature sends dropped the DM on their campaign list.
      //
      // The pattern is duplicated from `public/app.js` rather than imported —
      // it lives in browser code with no module boundary — so this test is a
      // copy that will not notice if the router itself changes. It is still
      // worth having: a dead link in the notice is the failure that actually
      // happened, and nothing else in the suite looks at the URL at all.
      const ROUTE = /^#\/c\/([a-z0-9-]{2,31})$/;
      const url = body()
        .split(/\s+/)
        .find((word) => word.startsWith("https://play.example.com"));

      expect(url, "the notice should carry a link at all").toBeDefined();
      expect(ROUTE.test(new URL(url!).hash)).toBe(true);
    });
  });

  describe("delivery", () => {
    it("mails the seated DM when a window opens", async () => {
      await setSeat(env.DB, CAMPAIGN, DM);
      const summary = await stub().resolveTick("manual");
      expect(summary.held).toBe(true);

      const mail = await settleSent(1);
      // Publication is held, so the notice is the *only* mail this turn.
      expect(mail).toHaveLength(1);
      expect(mail[0]!.to).toBe("dee@asyncrpg-fixtures.dev");
      expect(mail[0]!.subject).toBe(reviewNoticeSubject(campaignName, summary.tick));
    });

    it("carries the beat the DM is being asked to judge", async () => {
      await setSeat(env.DB, CAMPAIGN, DM);
      const summary = await stub().resolveTick("manual");
      const beat = await env.DB.prepare(
        "SELECT prose FROM beats WHERE campaign_id = ? AND tick = ?",
      ).bind(CAMPAIGN, summary.tick).first<{ prose: string }>();

      const mail = await settleSent(1);
      expect(mail[0]!.text).toContain(beat!.prose);
    });

    it("escapes narrative prose in the HTML part", async () => {
      await setSeat(env.DB, CAMPAIGN, DM);
      const summary = await stub().resolveTick("manual");
      // Prose is model output — untrusted by definition, and the notice is the
      // one mail whose body is a beat nobody has reviewed yet.
      await env.DB.prepare("UPDATE beats SET prose = ? WHERE campaign_id = ? AND tick = ?")
        .bind("<img src=x onerror=alert(1)>", CAMPAIGN, summary.tick).run();

      sent = [];
      await stub().publishHeldBeat();
      await stub().resolveTick("manual");
      const mail = await settleSent(1);
      const notice = mail.find((m) => m.subject.includes("ready for you"));
      expect(notice).toBeDefined();
      expect(notice!.html ?? "").not.toContain("<img src=x");
    });

    it("does not bind a reply, because the notice is not a turn prompt", async () => {
      // A `reply_bindings` row would file the DM's "looks good" as their
      // character's action for the turn they are reviewing.
      await setSeat(env.DB, CAMPAIGN, DM);
      await stub().resolveTick("manual");
      await settleSent(1);

      const { results } = await env.DB.prepare(
        "SELECT tick FROM reply_bindings WHERE campaign_id = ?",
      ).bind(CAMPAIGN).all<{ tick: number }>();
      expect(results).toEqual([]);
    });

    it("sends nothing extra when no DM holds the seat", async () => {
      const summary = await stub().resolveTick("manual");
      expect(summary.held).toBe(false);

      // Just the beat, to the one member with a character.
      const mail = await settleSent(1);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).not.toContain("ready for you");
    });

    it("holds the beat anyway when the notice cannot be sent", async () => {
      await setSeat(env.DB, CAMPAIGN, DM);
      (env as { EMAIL: Env["EMAIL"] }).EMAIL = {
        send: async () => {
          throw new Error("mail is down");
        },
      };

      const summary = await stub().resolveTick("manual");
      expect(summary.held).toBe(true);
      expect((await stub().reviewState()).heldTick).toBe(summary.tick);
    });

    it("holds the beat anyway when the DM has no address to send to", async () => {
      await setSeat(env.DB, CAMPAIGN, DM);
      // The seat row survives, the player row does not. `ON DELETE` is not set
      // on `dm_player_id`, so this is a state production can genuinely reach.
      await env.DB.prepare("DELETE FROM memberships WHERE player_id = ?").bind(DM).run();
      await env.DB.prepare("UPDATE players SET email = '' WHERE id = ?").bind(DM).run();

      const summary = await stub().resolveTick("manual");
      expect(summary.held).toBe(true);
      expect((await stub().reviewState()).phase).toBe("review");
    });
  });
});
