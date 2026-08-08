/**
 * Prose editing, publication on request, and window configuration: who may do
 * each, what is retained, and what readers are told.
 *
 * The recurring hazard in this file is a request that *fails to say something*
 * being read as a request to change it. `readJson` returns `null` for a body
 * that was unparseable and, identically, for one over the 32 KB cap — so every
 * endpoint here that could mutate state on absence is tested with no body at
 * all and with an oversized one, and must refuse both.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, resetDatabase } from "../helpers/schema";
import { mintSessionForTest } from "../helpers/session";
import { setSeat } from "../../src/dm/seat";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const SLUG = "edit";
const DM = "plr_dm";
const PLAYER = "plr_player";
const OUTSIDER = "plr_outsider";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** A fresh Durable Object per test — see the note in `dm-visibility.test.ts`. */
let campaignId = "cmp_edit";
let seq = 0;

function stub() {
  return env.CAMPAIGN.get(env.CAMPAIGN.idFromName(campaignId));
}

/** `body === undefined` sends no body at all, which is the point of several tests. */
async function call(
  method: string,
  path: string,
  playerId: string | null,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (playerId) headers.set("cookie", await mintSessionForTest(env, playerId));
  return worker.fetch!(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

async function seed(): Promise<void> {
  campaignId = `cmp_edit_${++seq}`;

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
     VALUES (?, ?, 'Editor', 'weekly', ?, ?)`,
  )
    .bind(campaignId, SLUG, DM, now)
    .run();

  await stub().init({ campaignId, slug: SLUG, name: "Editor", cadence: "weekly" });
  // Character names deliberately unlike the player ids, so the "attribution is
  // never a name" assertion below cannot pass by accident.
  for (const [id, name] of [
    [DM, "Dee"],
    [PLAYER, "Pat"],
  ]) {
    const joined = await stub().join(id!, name!);
    await env.DB.prepare(
      `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(campaignId, id, joined.characterId, joined.characterName, now)
      .run();
  }
  await setSeat(env.DB, campaignId, DM);

  await env.DB.prepare(
    `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
     VALUES (?, 4, 'The model wrote this.', 'At the ford.', 'model', ?, NULL)`,
  )
    .bind(campaignId, now)
    .run();
}

async function beat() {
  return env.DB.prepare(
    "SELECT prose, original_prose, revised_by, published_at FROM beats WHERE campaign_id = ? AND tick = 4",
  )
    .bind(campaignId)
    .first<{
      prose: string;
      original_prose: string | null;
      revised_by: string | null;
      published_at: string | null;
    }>();
}

async function windowMs(): Promise<number | null> {
  const row = await env.DB.prepare("SELECT review_window_ms FROM campaigns WHERE id = ?")
    .bind(campaignId)
    .first<{ review_window_ms: number | null }>();
  return row?.review_window_ms ?? null;
}

/**
 * One `reply_bindings` row is written per recipient per send, so this is the
 * externally visible record of mail actually going out.
 */
async function mailCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reply_bindings WHERE campaign_id = ?",
  )
    .bind(campaignId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("dm prose editing", () => {
  beforeEach(seed);

  it("rewrites the prose and retains the original", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, {
      tick: 4,
      prose: "The ford ran high, and they crossed it anyway.",
    });
    expect(res.status).toBe(200);

    const row = await beat();
    expect(row?.prose).toBe("The ford ran high, and they crossed it anyway.");
    expect(row?.original_prose).toBe("The model wrote this.");
    expect(row?.revised_by).toBe(DM);
  });

  it("keeps the first original across a second edit", async () => {
    await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, { tick: 4, prose: "First rewrite." });
    await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, { tick: 4, prose: "Second rewrite." });

    const row = await beat();
    expect(row?.prose).toBe("Second rewrite.");
    // The original is what the machine wrote, not the DM's previous draft.
    expect(row?.original_prose).toBe("The model wrote this.");
  });

  it("keeps the first original across a third edit too", async () => {
    for (const prose of ["One.", "Two.", "Three."]) {
      await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, { tick: 4, prose });
    }
    const row = await beat();
    expect(row?.prose).toBe("Three.");
    expect(row?.original_prose).toBe("The model wrote this.");
  });

  it("edits a published beat without re-sending mail", async () => {
    await env.DB.prepare("UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = 4")
      .bind(new Date().toISOString(), campaignId)
      .run();
    const before = await mailCount();

    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, {
      tick: 4,
      prose: "A correction, made after the fact.",
    });
    expect(res.status).toBe(200);

    // Give any stray fan-out time to land and fail this rather than race past.
    await new Promise((r) => setTimeout(r, 250));
    expect(await mailCount()).toBe(before);

    const row = await beat();
    expect(row?.prose).toBe("A correction, made after the fact.");
    expect(row?.original_prose).toBe("The model wrote this.");
    // Editing must not un-publish it.
    expect(row?.published_at).not.toBeNull();
  });

  it("refuses a member who does not hold the seat", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, PLAYER, {
      tick: 4,
      prose: "I rewrite the story.",
    });
    expect(res.status).toBe(403);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("refuses a non-member", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, OUTSIDER, {
      tick: 4,
      prose: "I am not even here.",
    });
    expect(res.status).toBe(403);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("refuses a logged-out caller", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, null, {
      tick: 4,
      prose: "Anonymous rewrite.",
    });
    expect(res.status).toBe(401);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("404s for a campaign that does not exist", async () => {
    const res = await call("PATCH", "/api/campaigns/nosuch/dm/beat", DM, { tick: 4, prose: "Hi." });
    expect(res.status).toBe(404);
  });

  it("rejects empty prose rather than blanking a beat", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, { tick: 4, prose: "   " });
    expect(res.status).toBe(400);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("rejects prose beyond the column's sane bound", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, {
      tick: 4,
      prose: "x".repeat(20_001),
    });
    expect(res.status).toBe(400);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("rejects a missing body rather than acting on a default", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM);
    expect(res.status).toBe(400);
    expect((await beat())?.prose).toBe("The model wrote this.");
    expect((await beat())?.revised_by).toBeNull();
  });

  it("rejects a body that arrives non-JSON", async () => {
    const res = await worker.fetch!(
      new Request(`https://example.com/api/campaigns/${SLUG}/dm/beat`, {
        method: "PATCH",
        headers: {
          cookie: await mintSessionForTest(env, DM),
          "content-type": "application/json",
        },
        body: "{not json",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("404s for a tick with no beat", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, { tick: 99, prose: "Hi." });
    expect(res.status).toBe(404);
  });

  it("rejects a non-integer tick", async () => {
    const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, {
      tick: "four",
      prose: "Hi.",
    });
    expect(res.status).toBe(400);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("serves the held beat to the DM for review", async () => {
    const res = await call("GET", `/api/campaigns/${SLUG}/dm/review`, DM);
    expect(res.status).toBe(200);
    const body = await res.json<{
      beat: { tick: number; prose: string; held: boolean } | null;
      phase: string;
    }>();
    expect(body.beat?.tick).toBe(4);
    expect(body.beat?.prose).toBe("The model wrote this.");
    expect(body.beat?.held).toBe(true);
    expect(body.phase).toBe("open");
  });

  it("refuses the review view to a non-DM", async () => {
    const res = await call("GET", `/api/campaigns/${SLUG}/dm/review`, PLAYER);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("The model wrote this.");
  });

  it("refuses the review view to a logged-out caller", async () => {
    expect((await call("GET", `/api/campaigns/${SLUG}/dm/review`, null)).status).toBe(401);
  });

  it("publishes on request", async () => {
    const res = await call("POST", `/api/campaigns/${SLUG}/dm/publish`, DM);
    expect(res.status).toBe(200);
  });

  it("publishes a genuinely held beat all the way through", async () => {
    // The real path: a tick resolves, the seat holds it, the DM releases it.
    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(true);

    const res = await call("POST", `/api/campaigns/${SLUG}/dm/publish`, DM);
    expect(res.status).toBe(200);
    expect(await res.json<{ published: boolean }>()).toMatchObject({ published: true });

    const row = await env.DB.prepare(
      "SELECT published_at FROM beats WHERE campaign_id = ? AND tick = ?",
    )
      .bind(campaignId, summary.tick)
      .first<{ published_at: string | null }>();
    expect(row?.published_at).not.toBeNull();
  });

  it("refuses publish from a non-DM", async () => {
    expect((await call("POST", `/api/campaigns/${SLUG}/dm/publish`, PLAYER)).status).toBe(403);
  });

  it("refuses publish from a logged-out caller", async () => {
    expect((await call("POST", `/api/campaigns/${SLUG}/dm/publish`, null)).status).toBe(401);
  });

  it("marks an edited beat in the public chronicle", async () => {
    await call("PATCH", `/api/campaigns/${SLUG}/dm/beat`, DM, { tick: 4, prose: "A better beat." });
    await env.DB.prepare("UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = 4")
      .bind(new Date().toISOString(), campaignId)
      .run();

    const page = await (
      await worker.fetch!(new Request(`https://example.com/c/${SLUG}`), env, ctx)
    ).text();
    expect(page).toContain("A better beat.");
    expect(page).toContain("Edited by the DM.");
    // Attribution is the fact, never the name.
    expect(page).not.toContain(DM);
  });

  it("does not mark an unedited beat", async () => {
    await env.DB.prepare("UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = 4")
      .bind(new Date().toISOString(), campaignId)
      .run();

    const page = await (
      await worker.fetch!(new Request(`https://example.com/c/${SLUG}`), env, ctx)
    ).text();
    expect(page).not.toContain("Edited by the DM.");
  });

  describe("window configuration", () => {
    it("sets a window", async () => {
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 3_600_000 });
      expect(res.status).toBe(200);
      expect(await res.json<{ clamped: boolean }>()).toMatchObject({ clamped: false });
      expect(await windowMs()).toBe(3_600_000);
    });

    it("clamps past the cadence cap and reports the clamp", async () => {
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, {
        ms: 30 * 24 * 3_600_000,
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ ms: number; clamped: boolean }>();
      expect(body.ms).toBe(56 * 3_600_000); // the weekly cap
      expect(body.clamped).toBe(true);
      // What was stored is what was reported, not what was asked for.
      expect(await windowMs()).toBe(56 * 3_600_000);
    });

    it("accepts zero as publish-immediately", async () => {
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 0 });
      expect(res.status).toBe(200);
      expect(await windowMs()).toBe(0);
    });

    it("accepts null as back-to-the-default", async () => {
      await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 0 });
      expect(await windowMs()).toBe(0);

      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: null });
      expect(res.status).toBe(200);
      // NULL and 0 are different settings and must not collapse into each other.
      expect(await windowMs()).toBeNull();
      expect(await res.json<{ ms: number }>()).toMatchObject({ ms: 24 * 3_600_000 });
    });

    it("does not reset the window when the body is missing", async () => {
      // The destructive-default trap: `body?.ms ?? null` would read a dropped
      // body as "back to the cadence default" and answer 200 OK.
      await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 0 });
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM);
      expect(res.status).toBe(400);
      expect(await windowMs()).toBe(0);
    });

    it("does not reset the window when the body is over the size cap", async () => {
      // `readJson` returns null for an oversized body exactly as for a broken
      // one, so a 40 KB body must be refused, not treated as an unset window.
      await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 0 });
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, {
        ms: null,
        pad: "x".repeat(40_000),
      });
      expect(res.status).toBe(400);
      expect(await windowMs()).toBe(0);
    });

    it("does not reset the window when the body omits ms", async () => {
      await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 0 });
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { nope: 1 });
      expect(res.status).toBe(400);
      expect(await windowMs()).toBe(0);
    });

    it("rejects a window that is not a number", async () => {
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: "an hour" });
      expect(res.status).toBe(400);
      expect(await windowMs()).toBeNull();
    });

    it("rejects a negative window", async () => {
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: -1 });
      expect(res.status).toBe(400);
      expect(await windowMs()).toBeNull();
    });

    it("rejects a fractional window rather than storing it in an INTEGER column", async () => {
      const res = await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 1500.5 });
      expect(res.status).toBe(400);
      expect(await windowMs()).toBeNull();
    });

    it("refuses a non-DM", async () => {
      expect(
        (await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, PLAYER, { ms: 0 })).status,
      ).toBe(403);
      expect(await windowMs()).toBeNull();
    });

    it("refuses a logged-out caller", async () => {
      expect((await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, null, { ms: 0 })).status).toBe(
        401,
      );
      expect(await windowMs()).toBeNull();
    });

    it("takes effect on the next held beat", async () => {
      // Configuration that no read path consumes is decoration. Zero means
      // publish immediately, and that is observable in the tick.
      await call("PATCH", `/api/campaigns/${SLUG}/dm/window`, DM, { ms: 0 });
      const summary = await stub().resolveTick("manual");
      expect(summary.held).toBe(false);
    });
  });
});
