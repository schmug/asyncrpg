/**
 * The dossier page: one entity, what it is, and where it has appeared.
 *
 * Runs the real router against a real D1 in the workers runtime, because the
 * access rule is the point — a private chronicle's dossier must stay private,
 * and an unrevealed threat must be indistinguishable from one that never was.
 *
 * The schema below is bootstrapped in a file-level `beforeAll`, outside every
 * `describe`, and declares every table this request path touches: `campaigns`
 * (slug lookup), `players`/`auth_tokens` (session), `memberships` (the
 * member check), `entities` and `events` (the page itself). A test that
 * depends on another test's setup passes in a full run and fails under `-t`,
 * and an undeclared table turns a real failure into expected-looking noise.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as runtimeEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { mintLoginToken, redeemLoginToken, SESSION_COOKIE } from "../../src/auth";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, cadence TEXT NOT NULL, quorum_fraction REAL NOT NULL DEFAULT 0.5,
  tick INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER, public_chronicle INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_tokens (token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL,
  purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS memberships (campaign_id TEXT NOT NULL, player_id TEXT NOT NULL,
  character_id TEXT NOT NULL, character_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player',
  joined_at TEXT NOT NULL, PRIMARY KEY (campaign_id, player_id));
CREATE TABLE IF NOT EXISTS entities (campaign_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (campaign_id, entity_id));
CREATE TABLE IF NOT EXISTS events (campaign_id TEXT NOT NULL, event_id TEXT NOT NULL,
  tick INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, region_id TEXT,
  summary TEXT NOT NULL, significance INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  target_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, event_id));
`;

const PUBLIC_ID = "cmp_pub";
const PRIVATE_ID = "cmp_priv";
const MEMBER_ID = "plr_member";
const now = "2026-08-08T00:00:00.000Z";

/**
 * Every raw field, agenda kind, and relation/attitude name that must never
 * reach the page (spec §8: "No agenda kind or target, no progress percentage,
 * no relation or attitude values, no raw danger or severity numbers").
 *
 * Copied deliberately from `test/lore/mentions.test.ts` so the two disclosure
 * assertions cannot drift: the blurb and the page it appears on answer to the
 * same rule. Each alternative is word-boundary anchored so a field *name*
 * leaking as text is caught without false-flagging the banded adjectives the
 * page is supposed to print — `dangerous` is prose, `danger` is a field.
 */
const DISCLOSURE_TERMS = [
  // Raw 0–100 fields.
  "power",
  "treasury",
  "prosperity",
  "unrest",
  "defense",
  "severity",
  "danger",
  "renown",
  "tension",
  // Agenda internals.
  "agendas?",
  "progress",
  "urgency",
  // Relation and attitude values.
  "relations?",
  "attitudes?",
  "bonds?",
  // All seven agenda kinds, raw and by stem.
  "seize_settlement",
  "seize",
  "enrich",
  "fortify",
  "undermine_rival",
  "undermine",
  "court_favor",
  "court",
  "hunt_threat",
  "hunt",
  "expand_influence",
  "expand",
];

const DISCLOSURE = new RegExp(DISCLOSURE_TERMS.map((t) => `\\b${t}\\b`).join("|"), "i");

/**
 * The stylesheet is full of incidental digits (`.78rem`), and it discloses
 * nothing. Number assertions run against the document without it.
 */
function withoutStyle(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "");
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`https://example.test${path}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function body(path: string, headers: Record<string, string> = {}): Promise<string> {
  return (await get(path, headers)).text();
}

async function seedEvent(opts: {
  id: string;
  tick: number;
  actor?: string | null;
  region?: string | null;
  targets?: string[];
  summary: string;
  significance?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                         summary, significance, data, target_ids, created_at)
     VALUES (?, ?, ?, 'agenda_advanced', ?, ?, ?, ?, '{}', ?, ?)`,
  )
    .bind(
      PUBLIC_ID,
      opts.id,
      opts.tick,
      opts.actor ?? null,
      opts.region ?? null,
      opts.summary,
      opts.significance ?? 40,
      JSON.stringify(opts.targets ?? []),
      now,
    )
    .run();
}

async function seedEntity(
  campaignId: string,
  entityId: string,
  kind: string,
  name: string,
  data: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO entities (campaign_id, entity_id, kind, name, data) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(campaignId, entityId, kind, name, data)
    .run();
}

beforeAll(async () => {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  for (const table of ["entities", "events", "memberships"]) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE campaign_id IN (?, ?)`)
      .bind(PUBLIC_ID, PRIVATE_ID)
      .run();
  }
  await env.DB.prepare("DELETE FROM campaigns WHERE id IN (?, ?)").bind(PUBLIC_ID, PRIVATE_ID).run();
  await env.DB.prepare("DELETE FROM auth_tokens WHERE player_id = ?").bind(MEMBER_ID).run();
  await env.DB.prepare("DELETE FROM players WHERE id = ?").bind(MEMBER_ID).run();

  await env.DB.prepare(
    `INSERT INTO campaigns (id, slug, name, cadence, public_chronicle, created_by, created_at)
     VALUES (?, 'pub', 'Ashfall', 'weekly', 1, 'plr_1', ?), (?, 'priv', 'Hidden', 'weekly', 0, 'plr_1', ?)`,
  )
    .bind(PUBLIC_ID, now, PRIVATE_ID, now)
    .run();

  await seedEntity(
    PUBLIC_ID,
    "fac_0",
    "faction",
    "The Ashen Coil",
    JSON.stringify({
      id: "fac_0",
      name: "The Ashen Coil",
      kind: "cult",
      power: 44,
      treasury: 30,
      seatSettlementId: "stl_0",
      agenda: { kind: "seize_settlement", targetId: "stl_1", progress: 78, urgency: 6 },
      relations: { fac_1: -80 },
      defunct: false,
    }),
  );
  await seedEntity(
    PUBLIC_ID,
    "stl_0",
    "settlement",
    "Vresford",
    JSON.stringify({
      id: "stl_0",
      name: "Vresford",
      regionId: "rgn_0",
      population: 3200,
      prosperity: 60,
      defense: 30,
      unrest: 12,
      razed: false,
    }),
  );
  await seedEntity(
    PUBLIC_ID,
    "rgn_0",
    "region",
    "Thornreach",
    JSON.stringify({ id: "rgn_0", name: "Thornreach", terrain: "forest", danger: 52, neighborIds: [] }),
  );
  await seedEntity(
    PUBLIC_ID,
    "npc_0",
    "npc",
    "Sera Coldwater",
    JSON.stringify({
      id: "npc_0",
      name: "Sera Coldwater",
      role: "steward",
      factionId: "fac_0",
      locationId: "stl_0",
      alive: true,
      traits: [],
      attitudes: { chr_1: 60 },
      renown: 40,
    }),
  );

  // A revealed threat, fully populated. `severity` is on the disclosure list
  // and *only* threats carry it, so without this row the one kind that could
  // leak it is the one kind never loaded.
  await seedEntity(
    PUBLIC_ID,
    "thr_0",
    "threat",
    "the Grey Blight",
    JSON.stringify({
      id: "thr_0",
      name: "the Grey Blight",
      kind: "blight",
      regionId: "rgn_0",
      severity: 66,
      growthRate: 2,
      revealed: true,
      resolved: false,
    }),
  );

  // The private campaign's row is deliberately `'{}'` — a half-written or
  // pre-migration projection is the shape a renderer actually meets.
  await seedEntity(PRIVATE_ID, "fac_0", "faction", "Secret Order", "{}");
});

describe("dossier page — identity", () => {
  it("renders a public dossier with the entity name", async () => {
    const res = await get("/c/pub/who/fac_0");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The Ashen Coil");
  });

  it("bands a settlement rather than printing its population", async () => {
    const html = await body("/c/pub/who/stl_0");
    expect(html).toContain("a town");
    expect(withoutStyle(html)).not.toContain("3200");
  });

  it("bands a region's danger into prose", async () => {
    const html = await body("/c/pub/who/rgn_0");
    expect(html).toContain("forest · dangerous");
    expect(withoutStyle(html)).not.toContain("52");
  });

  it("resolves an npc's faction and location by name", async () => {
    // "steward" alone is a poor answer to "who is this?" — the referenced rows
    // are what make the page worth loading.
    expect(await body("/c/pub/who/npc_0")).toContain("steward of The Ashen Coil, at Vresford");
  });

  it("escapes a name that carries markup", async () => {
    await seedEntity(PUBLIC_ID, "fac_x", "faction", "<script>alert(1)</script>", "{}");
    const html = await body("/c/pub/who/fac_x");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("routes a threat id and describes it without its severity", async () => {
    const res = await get("/c/pub/who/thr_0");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("the Grey Blight");
    expect(html).toContain(`<p class="sub">A trouble · a blight in Thornreach</p>`);
    expect(withoutStyle(html)).not.toContain("66");
  });

  it("links back to the chronicle", async () => {
    expect(await body("/c/pub/who/fac_0")).toContain(`href="/c/pub"`);
  });
});

describe("dossier page — disclosure", () => {
  it("discloses no agenda, relation, or raw 0-100 field on any kind's page", async () => {
    // All five routable kinds. `thr_0` earns its place twice over: `severity`
    // is on the term list and no other kind carries it.
    for (const id of ["fac_0", "stl_0", "rgn_0", "npc_0", "thr_0"]) {
      const html = await body(`/c/pub/who/${id}`);
      expect(html, id).not.toMatch(DISCLOSURE);
    }
  });

  it("prints no raw agenda progress or relation value", async () => {
    const html = withoutStyle(await body("/c/pub/who/fac_0"));
    expect(html).not.toContain("78");
    expect(html).not.toContain("-80");
    expect(html).not.toContain("44");
    expect(html).not.toContain("stl_1");
  });

  it("does not leak an npc's attitude values", async () => {
    const html = withoutStyle(await body("/c/pub/who/npc_0"));
    expect(html).not.toContain("60");
    expect(html).not.toMatch(/attitude/i);
  });
});

describe("dossier page — what the chronicle records", () => {
  it("shows an event linked only through target_ids", async () => {
    // The case that was impossible before issue #7 was fixed: no actor, the
    // entity named only as a target.
    await seedEvent({
      id: "e1",
      tick: 4,
      actor: null,
      targets: ["fac_0"],
      summary: "The Ashen Coil was driven from the chapterhouse.",
    });
    expect(await body("/c/pub/who/fac_0")).toContain("driven from the chapterhouse");
  });

  it("shows an event linked through actor_id", async () => {
    await seedEvent({ id: "e2", tick: 5, actor: "fac_0", summary: "The Ashen Coil marched north." });
    expect(await body("/c/pub/who/fac_0")).toContain("marched north");
  });

  it("lists an event once when the id appears twice in target_ids", async () => {
    // A join against `json_each` returns the row per matching element; the
    // `EXISTS` form returns it once. Repeated ids are real — an event can name
    // the same faction as both parties to a broken pact.
    await seedEvent({
      id: "e_dup",
      tick: 6,
      actor: "fac_0",
      targets: ["fac_0", "fac_0"],
      summary: "The Coil turned on itself.",
    });
    const html = await body("/c/pub/who/fac_0");
    expect(html.split("The Coil turned on itself.").length - 1).toBe(1);
  });

  it("does not show an event about a different entity", async () => {
    await seedEvent({
      id: "e3",
      tick: 5,
      actor: "fac_9",
      targets: ["fac_9"],
      summary: "Someone else entirely did a thing.",
    });
    expect(await body("/c/pub/who/fac_0")).not.toContain("Someone else entirely");
  });

  it("shows a region's own events on the region's page", async () => {
    await seedEvent({
      id: "e_rgn",
      tick: 3,
      actor: null,
      region: "rgn_0",
      summary: "Winter closed the passes.",
    });
    expect(await body("/c/pub/who/rgn_0")).toContain("Winter closed the passes");
  });

  it("does not fold a region's events into a settlement inside it", async () => {
    // `region_id` is matched only when the entity *is* the region; otherwise a
    // settlement's page becomes a regional feed.
    await seedEvent({
      id: "e_rgn2",
      tick: 3,
      actor: null,
      region: "rgn_0",
      summary: "Winter closed the passes.",
    });
    expect(await body("/c/pub/who/stl_0")).not.toContain("Winter closed the passes");
  });

  it("separates pre-play history from the live timeline", async () => {
    await seedEvent({
      id: "e4",
      tick: 0,
      targets: ["fac_0"],
      significance: 80,
      summary: "The Coil was founded in a bad year.",
    });
    const html = await body("/c/pub/who/fac_0");
    expect(html).toContain("Before you arrived");
    expect(html).toContain("founded in a bad year");
  });

  it("says so plainly when nothing has been recorded", async () => {
    expect(await body("/c/pub/who/fac_0")).toContain("Nothing recorded yet");
  });
});

describe("dossier page — malformed rows", () => {
  it("omits the subtitle for an empty row of every kind, inventing nothing", async () => {
    // One kind passing is not evidence for the others: `faction` happens to be
    // the only kind that declines an empty row naturally. `npc` read a missing
    // `alive` as dead and `settlement` read a missing `population` as "a
    // hamlet" — in-fiction facts fabricated out of a gap in a projected row,
    // on the one page a reader opens to find out what is true.
    const cases = [
      ["fac_e", "faction", "The Hollow Chapter", "A faction"],
      ["npc_e", "npc", "Halden Vrey", "A person"],
      ["stl_e", "settlement", "Elsewhere", "A place"],
      ["rgn_e", "region", "Nowhere", "A land"],
      ["thr_e", "threat", "the Nameless", "A trouble"],
    ] as const;

    for (const [id, kind, name, label] of cases) {
      await seedEntity(PUBLIC_ID, id, kind, name, "{}");
      const res = await get(`/c/pub/who/${id}`);
      expect(res.status, id).toBe(200);
      const html = await res.text();
      expect(html, id).toContain(`<h1>${name}</h1><p class="sub">${label}</p>`);
      expect(html, id).not.toContain("undefined");
      expect(html, id).not.toMatch(/\bdied\b|\ba hamlet\b|\bquiet\b|\babandoned\b/);
      // The identity block degrades; the rest of the page does not.
      expect(html, id).toContain("What the chronicle records");
      expect(html, id).toContain("Back to the chronicle");
    }
  });

  it("renders a usable page for a row whose data is an empty object", async () => {
    // Spec §10: an empty blurb means *omit the subtitle*, not render an empty
    // element and never the string "undefined".
    await seedEntity(PUBLIC_ID, "fac_empty", "faction", "The Hollow Chapter", "{}");
    const res = await get("/c/pub/who/fac_empty");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The Hollow Chapter");
    // "A faction", not the chronicle grid's "Powers": `power` is a raw 0–100
    // field on the same row, and a kind label that collides with a withheld
    // field name makes the disclosure rule untestable.
    expect(html).toContain(`<p class="sub">A faction</p>`);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("· </p>");
    expect(html).toContain("What the chronicle records");
  });

  it("renders a usable page for a row whose data is not valid JSON", async () => {
    await seedEntity(PUBLIC_ID, "npc_bad", "npc", "Halden Vrey", "{not json at all");
    const res = await get("/c/pub/who/npc_bad");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Halden Vrey");
    expect(html).toContain(`<p class="sub">A person</p>`);
    expect(html).not.toContain("undefined");
  });

  it("still shows the events of a row whose data is malformed", async () => {
    // The identity block degrades; the re-index of the chronicle does not.
    await seedEntity(PUBLIC_ID, "fac_empty", "faction", "The Hollow Chapter", "{}");
    await seedEvent({
      id: "e_empty",
      tick: 2,
      targets: ["fac_empty"],
      summary: "The Hollow Chapter kept its silence.",
    });
    expect(await body("/c/pub/who/fac_empty")).toContain("kept its silence");
  });

  it("renders the identity block when the events query fails", async () => {
    // A link in a *sent* email is permanent, so a broken events query costs the
    // timeline, not the page. Spec §10.
    await seedEvent({
      id: "e_fail",
      tick: 9,
      targets: ["fac_0"],
      summary: "This line depends on the events query.",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch!(
      new Request("https://example.test/c/pub/who/fac_0"),
      brokenEventsEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The Ashen Coil");
    expect(html).not.toContain("This line depends on the events query");
    expect(html).toContain("Nothing recorded yet");
  });
});

describe("dossier page — access and absence", () => {
  it("refuses a private chronicle to a signed-out reader", async () => {
    expect((await get("/c/priv/who/fac_0")).status).toBe(403);
  });

  it("serves a private chronicle to a signed-in member", async () => {
    await env.DB.prepare(
      "INSERT INTO players (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(MEMBER_ID, "member@example.test", "Member", now)
      .run();
    await env.DB.prepare(
      `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
       VALUES (?, ?, 'chr_1', 'Sera', ?)`,
    )
      .bind(PRIVATE_ID, MEMBER_ID, now)
      .run();
    const session = await redeemLoginToken(env, await mintLoginToken(env, MEMBER_ID));
    expect(session).not.toBeNull();

    const res = await get("/c/priv/who/fac_0", { cookie: `${SESSION_COOKIE}=${session}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Secret Order");
  });

  it("returns 404 for an entity that is not projected", async () => {
    // Unrevealed threats are never written to `entities`, so they land here —
    // indistinguishable from an id that never existed.
    expect((await get("/c/pub/who/thr_9")).status).toBe(404);
  });

  it("answers a missing entity with a page, not a bare 404", async () => {
    const res = await get("/c/pub/who/thr_9");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Back to the chronicle");
    expect(html).toContain("hasn't been written");
  });

  it("returns 404 for an unknown campaign", async () => {
    expect((await get("/c/nope/who/fac_0")).status).toBe(404);
  });

  it("does not route a character id", async () => {
    expect((await get("/c/pub/who/chr_abc")).status).toBe(404);
  });

  it("does not route an id of an unlisted prefix", async () => {
    expect((await get("/c/pub/who/evt_abc")).status).toBe(404);
  });
});

/**
 * The real env with a `DB` that fails only the events query. Cheaper and far
 * less invasive than dropping the table out from under a shared database, and
 * it exercises the route rather than the renderer in isolation.
 */
function brokenEventsEnv(): Env {
  const fail = async (): Promise<never> => {
    throw new Error("D1_ERROR: no such table: events");
  };
  const db = {
    prepare(sql: string) {
      if (!/FROM events/.test(sql)) return env.DB.prepare(sql);
      return { bind: () => ({ all: fail, first: fail, run: fail }) };
    },
  };
  return new Proxy(env as object, {
    get: (target, prop) => (prop === "DB" ? db : Reflect.get(target, prop)),
  }) as Env;
}
