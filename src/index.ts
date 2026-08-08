/**
 * Worker entry: HTTP for the web app, `email()` for play-by-mail.
 *
 * Both surfaces funnel into the same Durable Object method, so an action
 * submitted by email and one submitted from a phone are indistinguishable by
 * the time they reach the simulation.
 */

import { CampaignDO } from "./campaign-do";
import {
  clearedCookie,
  findOrCreatePlayer,
  INVITE_TTL_DAYS,
  mintInvite,
  peekInvite,
  redeemInvite,
  mintLoginToken,
  normalizeEmail,
  purgeExpiredTokens,
  rateLimit,
  redeemLoginToken,
  revokeSession,
  sessionCookie,
  sessionFrom,
} from "./auth";
import type { Session } from "./auth";
import { sendMagicLink } from "./email/outbound";
import { handleInboundEmail } from "./email/inbound";
import { getSeat, setSeat } from "./dm/seat";
import { renderChronicle } from "./web/chronicle";
import type { Env } from "./env";

export { CampaignDO };

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });

const fail = (status: number, error: string): Response => json({ error }, { status });

/** Security headers applied to every response we generate. */
function harden(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      // The zone has Cloudflare Web Analytics auto-injection enabled, which
      // rewrites a beacon script into every HTML response before it leaves the
      // edge. Under a strict `script-src 'self'` the browser blocks it on every
      // page load, which permanently reddens the console-error gate and makes
      // it useless for catching real errors. Allowing this one Cloudflare-owned
      // host is the narrowest fix available from inside the app; the tighter
      // option is turning auto-injection off at the zone, which is the domain
      // owner's call and not something to change unilaterally.
      "script-src 'self' https://static.cloudflareinsights.com; " +
      "connect-src 'self' https://cloudflareinsights.com; " +
      "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function readJson<T>(request: Request, maxBytes = 32_000): Promise<T | null> {
  const raw = await request.text();
  if (raw.length > maxBytes) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function stub(env: Env, campaignId: string) {
  return env.CAMPAIGN.get(env.CAMPAIGN.idFromName(campaignId));
}

interface CampaignRow {
  id: string;
  slug: string;
  name: string;
  cadence: string;
  created_by: string;
  public_chronicle: number;
}

async function campaignBySlug(env: Env, slug: string): Promise<CampaignRow | null> {
  if (!SLUG.test(slug)) return null;
  return env.DB.prepare(
    "SELECT id, slug, name, cadence, created_by, public_chronicle FROM campaigns WHERE slug = ?",
  )
    .bind(slug)
    .first<CampaignRow>();
}

async function isMember(env: Env, campaignId: string, playerId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM memberships WHERE campaign_id = ? AND player_id = ?",
  )
    .bind(campaignId, playerId)
    .first<{ ok: number }>();
  return row !== null;
}

// ─── routes ──────────────────────────────────────────────────────────────

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/health") {
    return json({ ok: true, service: "asyncrpg", time: new Date().toISOString() });
  }

  // ─── auth ──────────────────────────────────────────────────────────────
  if (path === "/api/auth/request" && method === "POST") {
    // Unauthenticated and it sends mail, so it is the obvious thing to abuse.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await rateLimit(env, `signin:${ip}`, 8))) {
      return fail(429, "too many sign-in requests — wait a minute and try again");
    }
    const body = await readJson<{ email?: string }>(request);
    const email = body?.email ? normalizeEmail(body.email) : null;
    // Always the same answer, valid address or not: this endpoint must not be
    // usable to discover which addresses have accounts.
    if (email) {
      const playerId = await findOrCreatePlayer(env, email);
      const token = await mintLoginToken(env, playerId);
      ctx.waitUntil(sendMagicLink(env, email, token).then(() => purgeExpiredTokens(env)));
    }
    return json({ ok: true, message: "If that address can sign in, a link is on its way." });
  }

  if (path === "/auth/callback" && method === "GET") {
    const token = url.searchParams.get("t") ?? "";
    const session = /^[a-f0-9]{16,128}$/.test(token) ? await redeemLoginToken(env, token) : null;
    if (!session) {
      return new Response("That sign-in link has expired or was already used. Request a new one.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": sessionCookie(session, url.protocol === "https:"),
      },
    });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    await revokeSession(env, request);
    return json({ ok: true }, { headers: { "set-cookie": clearedCookie } });
  }

  const session: Session | null = await sessionFrom(env, request);

  if (path === "/api/me") {
    // "Who am I?" answered for an anonymous visitor is `nobody`, not an error.
    // Returning 401 here made the browser log a console error on every
    // signed-out page load, which is noise that hides real failures. It leaks
    // nothing: an anonymous caller already knows they are anonymous.
    if (!session) return json({ player: null, campaigns: [] });
    const campaigns = await env.DB.prepare(
      `SELECT c.slug, c.name, c.tick, c.deadline_at, m.character_name
       FROM memberships m JOIN campaigns c ON c.id = m.campaign_id
       WHERE m.player_id = ? ORDER BY c.created_at DESC`,
    )
      .bind(session.playerId)
      .all();
    return json({ player: session, campaigns: campaigns.results });
  }

  // ─── chronicle (public, no session required) ───────────────────────────
  const chronicleMatch = /^\/c\/([a-z0-9-]{2,31})\/?$/.exec(path);
  if (chronicleMatch && method === "GET") {
    const campaign = await campaignBySlug(env, chronicleMatch[1]!);
    if (!campaign) return new Response("No such chronicle.", { status: 404 });
    if (campaign.public_chronicle !== 1 && !(session && (await isMember(env, campaign.id, session.playerId)))) {
      return new Response("This chronicle is private.", { status: 403 });
    }
    return renderChronicle(env, campaign);
  }

  // ─── joining by invitation ─────────────────────────────────────────────
  // Deliberately not `/api/campaigns/:slug/join`: knowing a slug is not
  // permission to enter someone's game, and every chronicle URL contains one.
  if (path === "/api/join" && method === "POST") {
    if (!session) return fail(401, "not signed in");
    const body = await readJson<{ token?: string; name?: string; concept?: string }>(request);
    const token = (body?.token ?? "").trim();
    const invite = await redeemInvite(env, token);
    if (!invite) return fail(400, "that invitation is not valid any more");

    const campaign = await env.DB.prepare(
      "SELECT id, slug, name FROM campaigns WHERE id = ?",
    )
      .bind(invite.campaignId)
      .first<{ id: string; slug: string; name: string }>();
    if (!campaign) return fail(404, "that campaign no longer exists");

    const name = (body?.name ?? session.displayName).trim().slice(0, 60) || "Someone";
    const joined = await stub(env, campaign.id).join(
      session.playerId,
      name,
      (body?.concept ?? "").trim().slice(0, 140) || undefined,
    );
    await env.DB.prepare(
      `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, role, joined_at)
       VALUES (?, ?, ?, ?, 'player', ?)
       ON CONFLICT(campaign_id, player_id) DO UPDATE SET character_name = excluded.character_name`,
    )
      .bind(campaign.id, session.playerId, joined.characterId, joined.characterName, new Date().toISOString())
      .run();
    return json({ ok: true, slug: campaign.slug, name: campaign.name, character: joined });
  }

  // Lets the invite screen say which campaign you were invited to before you
  // commit to a character name. Reveals only the name, never the contents.
  const previewMatch = /^\/api\/invite\/([a-f0-9]{16,128})$/.exec(path);
  if (previewMatch && method === "GET") {
    const invite = await peekInvite(env, previewMatch[1]!);
    if (!invite) return fail(404, "that invitation is not valid any more");
    return json({ ok: true, campaign: invite.campaignName });
  }

  // ─── campaigns ─────────────────────────────────────────────────────────
  if (path === "/api/campaigns" && method === "POST") {
    if (!session) return fail(401, "not signed in");
    const body = await readJson<{ name?: string; slug?: string; cadence?: string }>(request);
    const name = (body?.name ?? "").trim().slice(0, 80);
    const slug = (body?.slug ?? "").trim().toLowerCase();
    const cadence = body?.cadence ?? "weekly";
    if (!name) return fail(400, "name is required");
    if (!SLUG.test(slug)) return fail(400, "slug must be 2-31 chars, lowercase letters, digits, hyphens");
    if (!["daily", "weekly", "monthly"].includes(cadence)) return fail(400, "invalid cadence");
    if (await campaignBySlug(env, slug)) return fail(409, "that slug is taken");

    const id = `cmp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    // The creator holds the DM seat by default. Without this the column stays
    // NULL, no campaign ever holds a beat, and the review window is dead code.
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, dm_player_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, slug, name, cadence, session.playerId, session.playerId, new Date().toISOString())
      .run();

    const campaign = stub(env, id);
    await campaign.init({ campaignId: id, slug, name, cadence: cadence as "weekly" });
    const joined = await campaign.join(session.playerId, session.displayName);
    await env.DB.prepare(
      `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, role, joined_at)
       VALUES (?, ?, ?, ?, 'host', ?)`,
    )
      .bind(id, session.playerId, joined.characterId, joined.characterName, new Date().toISOString())
      .run();

    return json({ ok: true, slug, campaignId: id, character: joined }, { status: 201 });
  }

  // A second segment is allowed under `/dm` and nowhere else, because the DM
  // endpoints are the only nested ones (`/dm/beat`, `/dm/window`). A blanket
  // "up to two segments" would also route `/invite/extra` and `/resolve/now`,
  // turning a 404 into a 405 for every action — an API-surface change nothing
  // asked for. Group 2 captures the whole action with its leading slash —
  // `/invite`, `/action`, `/dm/window` — so every `action === "/…"` comparison
  // below is unaffected.
  const campaignMatch = /^\/api\/campaigns\/([a-z0-9-]{2,31})(\/dm\/[a-z]+|\/[a-z]+)?$/.exec(path);
  if (campaignMatch) {
    const campaign = await campaignBySlug(env, campaignMatch[1]!);
    if (!campaign) return fail(404, "no such campaign");
    const action = campaignMatch[2];
    const campaignStub = stub(env, campaign.id);

    if (!session) return fail(401, "not signed in");

    const member = await isMember(env, campaign.id, session.playerId);

    // Only the host can mint an invitation, and only members can see who is in.
    if (action === "/invite" && method === "POST") {
      if (campaign.created_by !== session.playerId) {
        return fail(403, "only the host can invite people");
      }
      const token = await mintInvite(env, campaign.id, session.playerId);
      return json({
        ok: true,
        url: `${env.PUBLIC_ORIGIN}/#/join/${token}`,
        expiresInDays: INVITE_TTL_DAYS,
      });
    }

    // The seat moves by host or by the sitting DM. Reading who holds it is a
    // member-level fact and is served by the campaign GET below, not here.
    if (action === "/dm" && method === "POST") {
      const seat = await getSeat(env.DB, campaign.id);
      const isHost = campaign.created_by === session.playerId;
      const isDm = seat?.dmPlayerId === session.playerId;
      if (!isHost && !isDm) return fail(403, "only the host or the current DM can move the seat");

      // Vacating has to be something the caller *said*, never something the
      // request failed to say. `readJson` returns `null` for an unparseable
      // body and, identically, for one over the size cap — so treating an
      // absent `playerId` as "vacate" would let a dropped body, a proxy that
      // stripped it, a truncated retry, or a body that grew past 32 KB empty
      // the seat and answer 200 OK. Only an explicit `{ playerId: null }`
      // vacates; anything that is not an object carrying that key is a 400.
      const body = await readJson<Record<string, unknown>>(request);
      if (body === null || typeof body !== "object" || Array.isArray(body) || !("playerId" in body)) {
        return fail(400, "send { playerId }, or { playerId: null } to vacate the seat");
      }
      // Still an unchecked cast over network input past this point: the key is
      // present, but its value is whatever the caller sent. Handing D1 a
      // non-string to bind throws inside the driver, surfacing a malformed
      // request as a 500.
      const target = body.playerId;
      if (target !== null) {
        if (typeof target !== "string") {
          return fail(400, "playerId must be a player id, or null to vacate the seat");
        }
        if (!(await isMember(env, campaign.id, target))) {
          return fail(400, "that person is not in this campaign");
        }
      }
      await setSeat(env.DB, campaign.id, target);
      return json({ ok: true, dmPlayerId: target });
    }

    if (!member) return fail(403, "you are not in this campaign");

    if (!action && method === "GET") {
      const [snapshot, prompt, sheet, latest, openFailures] = await Promise.all([
        campaignStub.snapshot(),
        campaignStub.promptForPlayer(session.playerId),
        campaignStub.mySheet(session.playerId),
        env.DB.prepare(
          "SELECT tick, prose, source FROM beats WHERE campaign_id = ? ORDER BY tick DESC LIMIT 1",
        )
          .bind(campaign.id)
          .first<{ tick: number; prose: string; source: string }>(),
        env.DB.prepare(
          "SELECT COUNT(*) AS n FROM projection_failures WHERE campaign_id = ? AND resolved_at IS NULL",
        )
          .bind(campaign.id)
          .first<{ n: number }>(),
      ]);
      return json({
        campaign: { slug: campaign.slug, ...snapshot },
        prompt,
        you: sheet,
        latestBeat: latest ?? null,
        playerId: session.playerId,
        isHost: campaign.created_by === session.playerId,
        // Surfaced to the host so a chronicle drifting from canon is visible
        // rather than something only a log would ever show.
        chronicleNeedsRepair: (openFailures?.n ?? 0) > 0,
      });
    }

    if (action === "/action" && method === "POST") {
      // A turn is a slow, expensive operation (intent parse + possibly a tick
      // with narration). Nobody legitimately submits twenty a minute.
      if (!(await rateLimit(env, `action:${session.playerId}`, 12))) {
        return fail(429, "slow down a moment");
      }
      const body = await readJson<{ text?: string }>(request);
      const text = (body?.text ?? "").trim();
      if (!text) return fail(400, "write what your character does");
      const result = await campaignStub.submitAction(session.playerId, text, "web");
      if (!result.accepted) return fail(400, result.reason ?? "not accepted");
      return json({ ok: true, resolvedNow: result.resolvedNow });
    }

    // ─── deep play: optional, and never an advantage ─────────────────────
    // These exist for people who want to do more between turns. None of them
    // changes a character's attributes or skills, so a player who ignores all
    // of it is not behind anyone — see src/sim/downtime.ts.
    if (action === "/downtime" && method === "POST") {
      const body = await readJson<{ kind?: string; detail?: string; targetId?: string }>(request);
      const out = await campaignStub.submitDowntime(
        session.playerId,
        (body?.kind ?? "").trim(),
        (body?.detail ?? "").trim().slice(0, 400),
        (body?.targetId ?? "").trim() || null,
      );
      if (!out.ok) return fail(400, out.reason ?? "could not do that");
      await env.DB.prepare(
        `INSERT INTO downtime (id, campaign_id, character_id, tick, kind, detail, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `dt_${crypto.randomUUID().slice(0, 12)}`,
          campaign.id,
          `chr_${session.playerId}`,
          0,
          body?.kind ?? "",
          (body?.detail ?? "").slice(0, 400),
          out.outcome ?? "",
          new Date().toISOString(),
        )
        .run()
        .catch(() => {});
      return json({ ok: true, outcome: out.outcome });
    }

    if (action === "/letter" && method === "POST") {
      const body = await readJson<{ to?: string; body?: string }>(request);
      const text = (body?.body ?? "").trim();
      const to = (body?.to ?? "").trim();
      if (text.length < 2) return fail(400, "write something");
      if (!to) return fail(400, "say who it is for");
      const snapshot = await campaignStub.snapshot();
      const recipient = snapshot.cast.find(
        (c) => c.characterId === to || c.name.toLowerCase() === to.toLowerCase(),
      );
      if (!recipient) return fail(400, "no such character in this campaign");

      await env.DB.prepare(
        `INSERT INTO letters (id, campaign_id, from_character, to_character, tick, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `ltr_${crypto.randomUUID().slice(0, 12)}`,
          campaign.id,
          `chr_${session.playerId}`,
          recipient.characterId,
          snapshot.tick,
          text.slice(0, 4000),
          new Date().toISOString(),
        )
        .run();
      await campaignStub.recordSideMaterial(
        "letter",
        `a letter was sent to ${recipient.name}: ${text.slice(0, 240)}`,
      );
      return json({ ok: true, to: recipient.name });
    }

    if (action === "/journal" && method === "POST") {
      const body = await readJson<{ title?: string; body?: string }>(request);
      const text = (body?.body ?? "").trim();
      if (text.length < 2) return fail(400, "write something");
      const snapshot = await campaignStub.snapshot();
      const mine = snapshot.cast.find((c) => c.playerId === session.playerId);

      await env.DB.prepare(
        `INSERT INTO journals (id, campaign_id, character_id, tick, title, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `jrn_${crypto.randomUUID().slice(0, 12)}`,
          campaign.id,
          mine?.characterId ?? `chr_${session.playerId}`,
          snapshot.tick,
          (body?.title ?? "").trim().slice(0, 120),
          text.slice(0, 8000),
          new Date().toISOString(),
        )
        .run();
      await campaignStub.recordSideMaterial(
        "journal",
        `${mine?.name ?? "someone"} wrote privately: ${text.slice(0, 240)}`,
      );
      return json({ ok: true });
    }

    if (action === "/reproject" && method === "POST") {
      if (campaign.created_by !== session.playerId) {
        return fail(403, "only the host can rebuild the chronicle");
      }
      const out = await campaignStub.reproject();
      return json({ ok: true, ...out });
    }

    if (action === "/resolve" && method === "POST") {
      if (campaign.created_by !== session.playerId) return fail(403, "only the host can force a turn");
      const outcome = await campaignStub.resolveTick("manual");
      return json({ ok: true, ...outcome });
    }

    return fail(405, "method not allowed");
  }

  if (path.startsWith("/api/")) return fail(404, "no such endpoint");

  // Everything else: the static app shell.
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return harden(await route(request, env, ctx));
    } catch (err) {
      console.error("unhandled", err);
      return harden(fail(500, "something went wrong"));
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
