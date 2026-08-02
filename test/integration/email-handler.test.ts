/**
 * Inbound email handler, exercised for real.
 *
 * Runs the actual exported `email()` function over real MIME bytes against a
 * real database in the workers runtime. This is what covers the parsing,
 * authorization, and rejection logic that `scripts/email-e2e.mjs` explicitly
 * says it does not cover.
 *
 * It does not prove Cloudflare delivers to the handler — nothing here can.
 * It proves that when Cloudflare does, the right thing happens.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as runtimeEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { mintReplyCode } from "../../src/email/token";

// The runtime resolves bindings from wrangler.jsonc, but `cloudflare:workers`
// types `env` as the empty ambient `Cloudflare.Env`. Narrow it once here
// rather than casting at every call site.
const env = runtimeEnv as unknown as Env;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, cadence TEXT NOT NULL, quorum_fraction REAL NOT NULL DEFAULT 0.5,
  tick INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER, public_chronicle INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (campaign_id TEXT NOT NULL, player_id TEXT NOT NULL,
  character_id TEXT NOT NULL, character_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player',
  joined_at TEXT NOT NULL, PRIMARY KEY (campaign_id, player_id));
CREATE TABLE IF NOT EXISTS reply_bindings (code TEXT PRIMARY KEY, message_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL, player_id TEXT NOT NULL, tick INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
`;

/** Build MIME bytes that look like a real client's reply. */
function mime(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  html?: boolean;
}): Uint8Array {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <reply-${Math.random().toString(36).slice(2)}@mail.example>`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: ${opts.html ? "text/html" : "text/plain"}; charset=utf-8`,
  ];
  return new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${opts.body}`);
}

interface Rejection {
  rejected: boolean;
  reason: string;
}

function message(bytes: Uint8Array, from: string, to: string) {
  const state: Rejection = { rejected: false, reason: "" };
  const msg = {
    from,
    to,
    headers: new Headers(),
    rawSize: bytes.length,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    setReject(reason: string) {
      state.rejected = true;
      state.reason = reason;
    },
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
  return { msg, state };
}

const CAMPAIGN = "cmp_test";
const PLAYER = "plr_test";
const PLAYER_EMAIL = "player@example.com";
const INBOX = `rpg@${env.MAIL_DOMAIN}`;
const BOUND_MESSAGE_ID = "beat-abc-123@cortech.online";
const CODE = "k7f2q9x";

async function deliver(bytes: Uint8Array, from: string, to = INBOX) {
  const { msg, state } = message(bytes, from, to);
  const ctx = createExecutionContext();
  await worker.email!(msg, env, ctx);
  await waitOnExecutionContext(ctx).catch(() => {
    /* the DO call may fail in tests; rejection behavior is what we assert */
  });
  return state;
}

describe("inbound email handler", () => {
  beforeAll(async () => {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
  });

  beforeEach(async () => {
    for (const t of ["reply_bindings", "memberships", "campaigns", "players"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO players (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(PLAYER, PLAYER_EMAIL, "Player", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(CAMPAIGN, "testhold", "Test Hold", "weekly", PLAYER, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at) VALUES (?,?,?,?,?)",
    )
      .bind(CAMPAIGN, PLAYER, `chr_${PLAYER}`, "Kestrel", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO reply_bindings (code, message_id, campaign_id, player_id, tick, expires_at, created_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(CODE, BOUND_MESSAGE_ID, CAMPAIGN, PLAYER, 3, Date.now() + 86_400_000, now)
      .run();
  });

  describe("accepts a legitimate reply", () => {
    it("accepts a threaded reply from a member", async () => {
      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3 — The Envoy`,
          inReplyTo: `<${BOUND_MESSAGE_ID}>`,
          body: "I open the gate and let him in.\r\n\r\nOn Mon, Ashfall wrote:\r\n> The envoy waits.",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(false);
    });

    it("accepts a reply bound only by the subject code (no threading headers)", async () => {
      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `RE: [Test Hold #${CODE}] Tick 3 — The Envoy`,
          body: "I refuse him entry.",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(false);
    });

    it("accepts a fresh mail from a player who is in exactly one campaign", async () => {
      const state = await deliver(
        mime({ from: PLAYER_EMAIL, to: INBOX, subject: "hello", body: "I go north." }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(false);
    });

    it("accepts an address whose case differs", async () => {
      const state = await deliver(
        mime({ from: "PLAYER@EXAMPLE.COM", to: INBOX, subject: "x", body: "I wait." }),
        "PLAYER@EXAMPLE.COM",
      );
      expect(state.rejected).toBe(false);
    });

    it("accepts an HTML-only reply", async () => {
      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          html: true,
          body: "<div><p>I climb the wall and look out.</p></div>",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(false);
    });
  });

  describe("sender identification", () => {
    it("accepts a reply whose envelope sender was rewritten by the provider", async () => {
      // Found by the live round-trip test: Cloudflare Email Sending rewrites
      // the SMTP MAIL FROM to `bounces@cf-bounce.<domain>`, so authenticating
      // on the envelope alone rejected every legitimate reply that had passed
      // through it. Mailing lists and forwarders do the same thing.
      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          body: "I hold the gate.",
        }),
        "bounces@cf-bounce.example.com",
      );
      expect(state.rejected).toBe(false);
    });

    it("still rejects when neither the envelope nor the header names a player", async () => {
      const state = await deliver(
        mime({
          from: "stranger@example.com",
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          body: "I take the crown.",
        }),
        "bounces@cf-bounce.example.com",
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/not registered/i);
    });

    it("does not let a header From alone impersonate another player on a bound reply", async () => {
      // The binding names PLAYER; a message claiming to be from a different
      // member must not be accepted against it.
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO players (id, email, display_name, created_at) VALUES (?,?,?,?)",
      )
        .bind("plr_other", "other@example.com", "Other", now)
        .run();
      await env.DB.prepare(
        "INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at) VALUES (?,?,?,?,?)",
      )
        .bind(CAMPAIGN, "plr_other", "chr_other", "Other", now)
        .run();

      const state = await deliver(
        mime({
          from: "other@example.com",
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          inReplyTo: `<${BOUND_MESSAGE_ID}>`,
          body: "I act as Kestrel.",
        }),
        "other@example.com",
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/does not belong to you/i);
    });
  });

  describe("rejects what it should", () => {
    it("rejects mail to an address that is not the inbox", async () => {
      const state = await deliver(
        mime({ from: PLAYER_EMAIL, to: "security@cortech.online", subject: "x", body: "hi" }),
        PLAYER_EMAIL,
        "security@cortech.online",
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/not accepting mail/i);
    });

    it("rejects a sender with no account", async () => {
      const state = await deliver(
        mime({ from: "stranger@example.com", to: INBOX, subject: "x", body: "I take the crown." }),
        "stranger@example.com",
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/not registered/i);
    });

    it("rejects a registered player who is in no campaign", async () => {
      await env.DB.prepare("DELETE FROM memberships").run();
      await env.DB.prepare("DELETE FROM reply_bindings").run();
      const state = await deliver(
        mime({ from: PLAYER_EMAIL, to: INBOX, subject: "x", body: "I act." }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/not in a campaign/i);
    });

    it("refuses to guess when a player is in several campaigns and gives no binding", async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at) VALUES (?,?,?,?,?,?)",
      )
        .bind("cmp_other", "other", "Other", "weekly", PLAYER, now)
        .run();
      await env.DB.prepare(
        "INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at) VALUES (?,?,?,?,?)",
      )
        .bind("cmp_other", PLAYER, "chr_other", "Other", now)
        .run();

      const state = await deliver(
        mime({ from: PLAYER_EMAIL, to: INBOX, subject: "no code here", body: "I act." }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/which story/i);
    });

    it("rejects a forwarded beat used by someone other than its owner", async () => {
      // The classic escalation: a player forwards their turn email to a
      // friend, who replies. The binding names the original player, so the
      // reply must not be accepted as theirs.
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO players (id, email, display_name, created_at) VALUES (?,?,?,?)",
      )
        .bind("plr_friend", "friend@example.com", "Friend", now)
        .run();
      await env.DB.prepare(
        "INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at) VALUES (?,?,?,?,?)",
      )
        .bind(CAMPAIGN, "plr_friend", "chr_friend", "Friend", now)
        .run();

      const state = await deliver(
        mime({
          from: "friend@example.com",
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          inReplyTo: `<${BOUND_MESSAGE_ID}>`,
          body: "I act as Kestrel.",
        }),
        "friend@example.com",
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/does not belong to you/i);
    });

    it("rejects a reply to a beat the story has already moved past", async () => {
      // Replay defense. The binding describes tick 3; the campaign is on tick
      // 6. Acting on intent formed three turns ago would submit a decision
      // about a world that no longer exists, so it bounces with a pointer to
      // the current turn rather than resolving quietly.
      await env.DB.prepare("UPDATE campaigns SET tick = ? WHERE id = ?").bind(6, CAMPAIGN).run();

      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3 — The Envoy`,
          inReplyTo: `<${BOUND_MESSAGE_ID}>`,
          body: "I open the gate and let him in.",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/turn 3 and the story is on turn 6/i);
    });

    it("still accepts a reply to the turn that has only just resolved", async () => {
      // One turn of slack: mail sent for tick 3 is often answered just as tick
      // 4 opens, and bouncing that would punish a player for ordinary latency.
      await env.DB.prepare("UPDATE campaigns SET tick = ? WHERE id = ?").bind(4, CAMPAIGN).run();

      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          inReplyTo: `<${BOUND_MESSAGE_ID}>`,
          body: "I open the gate.",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(false);
    });

    it("does not honour a reply code that fails to authenticate its binding", async () => {
      // A current-format code is an HMAC over the (campaign, player, tick) it
      // names. Here the stored row says tick 9 while the code was minted for
      // tick 3, so the code does not authenticate the row it found and is
      // treated as absent. The player is in two campaigns, so with no usable
      // binding there is nothing left to disambiguate on — which is exactly
      // the outcome a forged code should produce.
      const now = new Date().toISOString();
      const minted = await mintReplyCode(env.EMAIL_TOKEN_SECRET, {
        campaignId: CAMPAIGN,
        playerId: PLAYER,
        tick: 3,
      });
      await env.DB.prepare(
        "INSERT INTO reply_bindings (code, message_id, campaign_id, player_id, tick, expires_at, created_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(minted, "beat-tampered@cortech.online", CAMPAIGN, PLAYER, 9, Date.now() + 86_400_000, now)
        .run();
      await env.DB.prepare(
        "INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at) VALUES (?,?,?,?,?,?)",
      )
        .bind("cmp_second", "second", "Second", "weekly", PLAYER, now)
        .run();
      await env.DB.prepare(
        "INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at) VALUES (?,?,?,?,?)",
      )
        .bind("cmp_second", PLAYER, "chr_second", "Second", now)
        .run();

      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${minted}] Tick 9`,
          body: "I act.",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/which story/i);
    });

    it("rejects a reply whose body is only quoted text", async () => {
      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          body: "\r\n\r\n-- \r\nSent from my iPhone",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(true);
      expect(state.reason).toMatch(/no action/i);
    });

    it("does not accept an expired binding as proof of identity", async () => {
      await env.DB.prepare("UPDATE reply_bindings SET expires_at = ?").bind(Date.now() - 1000).run();
      // The binding is dead, but this player is still in exactly one campaign,
      // so the reply should still land — degraded, not rejected.
      const state = await deliver(
        mime({
          from: PLAYER_EMAIL,
          to: INBOX,
          subject: `Re: [Test Hold #${CODE}] Tick 3`,
          body: "I keep going.",
        }),
        PLAYER_EMAIL,
      );
      expect(state.rejected).toBe(false);
    });

    it("rejects unreadable MIME rather than throwing", async () => {
      const { msg, state } = message(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), PLAYER_EMAIL, INBOX);
      const ctx = createExecutionContext();
      await expect(worker.email!(msg, env, ctx)).resolves.toBeUndefined();
      // Either it parsed to nothing and was rejected for having no action, or
      // it failed to parse and was rejected outright. Both are acceptable;
      // silently accepting garbage is not.
      expect(state.rejected).toBe(true);
    });
  });
});
