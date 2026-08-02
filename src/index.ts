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
  mintLoginToken,
  normalizeEmail,
  purgeExpiredTokens,
  redeemLoginToken,
  revokeSession,
  sessionCookie,
  sessionFrom,
} from "./auth";
import type { Session } from "./auth";
import { sendMagicLink } from "./email/outbound";
import { handleInboundEmail } from "./email/inbound";
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
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, slug, name, cadence, session.playerId, new Date().toISOString())
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

  const campaignMatch = /^\/api\/campaigns\/([a-z0-9-]{2,31})(\/[a-z]+)?$/.exec(path);
  if (campaignMatch) {
    const campaign = await campaignBySlug(env, campaignMatch[1]!);
    if (!campaign) return fail(404, "no such campaign");
    const action = campaignMatch[2];
    const campaignStub = stub(env, campaign.id);

    if (!session) return fail(401, "not signed in");

    if (action === "/join" && method === "POST") {
      const body = await readJson<{ name?: string; concept?: string }>(request);
      const name = (body?.name ?? session.displayName).trim().slice(0, 60) || "Someone";
      const joined = await campaignStub.join(
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
      return json({ ok: true, character: joined });
    }

    const member = await isMember(env, campaign.id, session.playerId);
    if (!member) return fail(403, "you are not in this campaign");

    if (!action && method === "GET") {
      const snapshot = await campaignStub.snapshot();
      const prompt = await campaignStub.promptForPlayer(session.playerId);
      return json({ campaign: { slug: campaign.slug, ...snapshot }, prompt });
    }

    if (action === "/action" && method === "POST") {
      const body = await readJson<{ text?: string }>(request);
      const text = (body?.text ?? "").trim();
      if (!text) return fail(400, "write what your character does");
      const result = await campaignStub.submitAction(session.playerId, text, "web");
      if (!result.accepted) return fail(400, result.reason ?? "not accepted");
      return json({ ok: true, resolvedNow: result.resolvedNow });
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
