/**
 * The DM seat: who holds it, who can move it, and what the window resolves to.
 *
 * The fixture runs the real migrations, so `PRAGMA foreign_keys` is on and
 * every `REFERENCES` clause bites. Seeding order is therefore load-bearing:
 * `players` before `campaigns` (created_by, dm_player_id) before `memberships`.
 * `resetDatabase` between tests rather than `DELETE FROM` — sessions minted for
 * the endpoint tests leave `auth_tokens` rows that reference `players`, and a
 * hand-maintained delete order would silently rot the first time a migration
 * adds another child table.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema, resetDatabase } from "../helpers/schema";
import { mintSessionForTest } from "../helpers/session";
import { DEFAULT_WINDOW_MS, getSeat, resolveWindowMs, setSeat } from "../../src/dm/seat";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const CAMPAIGN = "cmp_seat";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(
  path: string,
  init: { method?: string; playerId?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.playerId) headers.cookie = await mintSessionForTest(env, init.playerId);
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env,
    execCtx,
  );
}

describe("dm seat", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
    await applySchema(env.DB);

    const now = new Date().toISOString();
    for (const [id, email] of [
      ["plr_host", "host@example.com"],
      ["plr_two", "two@example.com"],
    ]) {
      await env.DB.prepare("INSERT INTO players (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, email, id, now)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES (?, 'seat', 'Seat', 'weekly', 'plr_host', ?)`,
    )
      .bind(CAMPAIGN, now)
      .run();
  });

  it("reads an empty seat", async () => {
    const seat = await getSeat(env.DB, CAMPAIGN);
    expect(seat).toEqual({ dmPlayerId: null, reviewWindowMs: null, missedWindows: 0 });
  });

  it("returns null for a campaign that does not exist", async () => {
    expect(await getSeat(env.DB, "cmp_nope")).toBeNull();
  });

  it("assigns and vacates the seat", async () => {
    await setSeat(env.DB, CAMPAIGN, "plr_two");
    expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_two");

    await setSeat(env.DB, CAMPAIGN, null);
    expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBeNull();
  });

  it("resets the missed-window counter when the seat moves", async () => {
    await env.DB.prepare("UPDATE campaigns SET dm_missed_windows = 2 WHERE id = ?")
      .bind(CAMPAIGN)
      .run();
    await setSeat(env.DB, CAMPAIGN, "plr_two");
    expect((await getSeat(env.DB, CAMPAIGN))?.missedWindows).toBe(0);
  });

  it("reaches the same seat state whichever way it got there", async () => {
    // Seat identity: "plr_two holds the seat" is one state, not two. A
    // reassignment that left a stale miss count behind would make the DO's
    // reversion logic depend on history rather than on who is sitting.
    await setSeat(env.DB, CAMPAIGN, "plr_two");
    const direct = await getSeat(env.DB, CAMPAIGN);

    await env.DB.prepare("UPDATE campaigns SET dm_missed_windows = 2 WHERE id = ?")
      .bind(CAMPAIGN)
      .run();
    await setSeat(env.DB, CAMPAIGN, "plr_host");
    await setSeat(env.DB, CAMPAIGN, "plr_two");

    expect(await getSeat(env.DB, CAMPAIGN)).toEqual(direct);
  });

  describe("resolveWindowMs", () => {
    it("uses the cadence default when unconfigured", () => {
      expect(resolveWindowMs("weekly", null)).toBe(DEFAULT_WINDOW_MS.weekly);
      expect(resolveWindowMs("daily", null)).toBe(DEFAULT_WINDOW_MS.daily);
      expect(resolveWindowMs("monthly", null)).toBe(DEFAULT_WINDOW_MS.monthly);
    });

    it("honours an explicit zero rather than treating it as unset", () => {
      // The whole reason this cannot be `configured ?? DEFAULT[cadence]`.
      expect(resolveWindowMs("weekly", 0)).toBe(0);
      expect(resolveWindowMs("daily", 0)).toBe(0);
      expect(resolveWindowMs("monthly", 0)).toBe(0);
    });

    it("keeps null and zero distinguishable on every cadence", () => {
      for (const cadence of ["daily", "weekly", "monthly"] as const) {
        expect(resolveWindowMs(cadence, null)).not.toBe(resolveWindowMs(cadence, 0));
      }
    });

    it("passes a window through untouched when it is under the cap", () => {
      expect(resolveWindowMs("weekly", 3_600_000)).toBe(3_600_000);
    });

    it("clamps to the cadence cap", () => {
      // 10 days on a daily campaign would swallow ten whole turns.
      expect(resolveWindowMs("daily", 10 * 86_400_000)).toBe(8 * 3_600_000);
      expect(resolveWindowMs("weekly", 10 * 86_400_000)).toBe(56 * 3_600_000);
      expect(resolveWindowMs("monthly", 100 * 86_400_000)).toBe(10 * 86_400_000);
    });

    it("rejects a negative window", () => {
      expect(resolveWindowMs("weekly", -5)).toBe(0);
    });

    it("rejects a window that is not a finite number", () => {
      expect(resolveWindowMs("weekly", Number.NaN)).toBe(0);
      expect(resolveWindowMs("weekly", Number.POSITIVE_INFINITY)).toBe(0);
    });

    it("falls back to the weekly default for an unknown cadence", () => {
      expect(resolveWindowMs("fortnightly", null)).toBe(DEFAULT_WINDOW_MS.weekly);
    });

    it("resolves a stored window straight off the seat", () => {
      // The pair this exists to serve: `getSeat` hands back `reviewWindowMs`
      // exactly as stored, and `resolveWindowMs` is what turns it into a delay.
      expect(resolveWindowMs("weekly", null)).toBe(DEFAULT_WINDOW_MS.weekly);
    });
  });

  describe("POST /api/campaigns/:slug/dm", () => {
    const post = (playerId: string, body: unknown) =>
      call("/api/campaigns/seat/dm", { method: "POST", playerId, body });

    beforeEach(async () => {
      const now = new Date().toISOString();
      for (const id of ["plr_host", "plr_two"]) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO memberships
             (campaign_id, player_id, character_id, character_name, joined_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(CAMPAIGN, id, `chr_${id}`, id, now)
          .run();
      }
    });

    it("lets the host designate someone else", async () => {
      const res = await post("plr_host", { playerId: "plr_two" });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_two");
    });

    it("lets the sitting DM hand the seat on", async () => {
      await setSeat(env.DB, CAMPAIGN, "plr_two");
      const res = await post("plr_two", { playerId: "plr_host" });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_host");
    });

    it("lets the host reclaim from a DM who will not give it up", async () => {
      await setSeat(env.DB, CAMPAIGN, "plr_two");
      const res = await post("plr_host", { playerId: "plr_host" });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_host");
    });

    it("refuses a member who is neither host nor DM", async () => {
      const res = await post("plr_two", { playerId: "plr_two" });
      expect(res.status).toBe(403);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBeNull();
    });

    it("refuses to seat someone who is not in the campaign", async () => {
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO players (id, email, display_name, created_at) VALUES (?,?,?,?)")
        .bind("plr_out", "out@example.com", "Out", now)
        .run();
      const res = await post("plr_host", { playerId: "plr_out" });
      expect(res.status).toBe(400);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBeNull();
    });

    it("vacates on an explicit null", async () => {
      await setSeat(env.DB, CAMPAIGN, "plr_two");
      const res = await post("plr_host", { playerId: null });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBeNull();
    });

    it("rejects a playerId that is not a string instead of failing at the driver", async () => {
      // `readJson` is an unchecked cast over network input. Handing D1 an
      // object to bind throws inside the driver and surfaces as a 500, which
      // is the wrong answer to a malformed request.
      const res = await post("plr_host", { playerId: { toString: "plr_two" } });
      expect(res.status).toBe(400);
    });

    it("refuses an unauthenticated caller", async () => {
      const res = await call("/api/campaigns/seat/dm", {
        method: "POST",
        body: { playerId: "plr_two" },
      });
      expect(res.status).toBe(401);
    });

    it("seats the creator when a campaign is made", async () => {
      const res = await call("/api/campaigns", {
        method: "POST",
        playerId: "plr_two",
        body: { name: "Fresh", slug: "freshhold", cadence: "weekly" },
      });
      expect(res.status).toBe(201);

      const row = await env.DB.prepare(
        "SELECT id, dm_player_id FROM campaigns WHERE slug = 'freshhold'",
      ).first<{ id: string; dm_player_id: string | null }>();
      expect(row?.dm_player_id).toBe("plr_two");
      // And the seat reads back through the same accessor the DO will use.
      expect((await getSeat(env.DB, row!.id))?.dmPlayerId).toBe("plr_two");
    });
  });

  describe("the campaign route regex", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO memberships
           (campaign_id, player_id, character_id, character_name, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(CAMPAIGN, "plr_two", "chr_plr_two", "Two", now)
        .run();

      // Every action branch below must answer from its *own* logic, not from a
      // 500 thrown by an unborn Durable Object — otherwise "not 404" would pass
      // even if the regex handed the branch the wrong action string.
      const campaign = env.CAMPAIGN.get(env.CAMPAIGN.idFromName(CAMPAIGN));
      await campaign.init({ campaignId: CAMPAIGN, slug: "seat", name: "Seat", cadence: "weekly" });
      const snapshot = await campaign.snapshot();
      if (!snapshot.cast.some((c) => c.playerId === "plr_two")) {
        await campaign.join("plr_two", "Two");
      }
    });

    /**
     * Widening the pattern to two segments must not un-route anything that
     * already worked, and — the subtler risk — must keep capture group 2 equal
     * to exactly the action segment. A group that captured `/seat/action` or
     * `action` would still match the path while silently failing every
     * `action === "/…"` comparison inside the branch, so each row below asserts
     * the response that *only that branch* can produce. `plr_two` is a member
     * and not the host, which is what makes the host-gated branches answer
     * distinguishably.
     */
    const ROUTED: Array<[string, string, unknown, number, string]> = [
      ["/invite", "POST", undefined, 403, "only the host can invite people"],
      ["/action", "POST", { text: "" }, 400, "write what your character does"],
      ["/downtime", "POST", { kind: "", detail: "" }, 400, "unknown downtime activity"],
      ["/letter", "POST", {}, 400, "write something"],
      ["/journal", "POST", {}, 400, "write something"],
      ["/reproject", "POST", undefined, 403, "only the host can rebuild the chronicle"],
      ["/resolve", "POST", undefined, 403, "only the host can force a turn"],
      [
        "/dm",
        "POST",
        { playerId: null },
        403,
        "only the host or the current DM can move the seat",
      ],
    ];

    for (const [action, method, body, status, error] of ROUTED) {
      it(`still routes ${method} ${action} to its own branch`, async () => {
        const res = await call(`/api/campaigns/seat${action}`, {
          method,
          playerId: "plr_two",
          body,
        });
        expect(res.status, action).toBe(status);
        expect(await res.json(), action).toEqual({ error });
      });
    }

    it("still 404s an unknown campaign rather than leaking a 401", async () => {
      const res = await call("/api/campaigns/nosuchhold/invite", {
        method: "POST",
        playerId: "plr_two",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no such campaign" });
    });

    it("still serves the bare campaign GET", async () => {
      const res = await call("/api/campaigns/seat", { playerId: "plr_two" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { campaign: { slug: string } };
      expect(body.campaign.slug).toBe("seat");
    });

    it("routes a nested two-segment action into the campaign branch", async () => {
      // What the widening is for: `/dm/window` and `/dm/beat` land in Tasks 4
      // and 6. Until then they must 405 from inside the branch, not 404 from
      // outside it — that is the difference the regex makes.
      const res = await call("/api/campaigns/seat/dm/window", {
        method: "POST",
        playerId: "plr_two",
      });
      expect(res.status).toBe(405);
    });

    it("does not route a path with an uppercase or numeric action segment", async () => {
      for (const path of ["/api/campaigns/seat/DM", "/api/campaigns/seat/dm2"]) {
        const res = await call(path, { method: "POST", playerId: "plr_two" });
        expect(res.status, path).toBe(404);
        expect(await res.json(), path).toEqual({ error: "no such endpoint" });
      }
    });
  });
});
