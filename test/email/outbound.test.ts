/**
 * Beat mail rendering.
 *
 * The load-bearing assertions are the two invariants: nothing player- or
 * model-authored reaches the HTML part unescaped, and a beat with no
 * recognised names renders byte-for-byte what it rendered before this feature
 * existed.
 *
 * `sendBeat` really writes `reply_bindings` on the way out, so the schema is
 * declared here — every table this path touches, so a genuine failure cannot
 * hide inside the "reply binding insert failed" log line that a missing table
 * would otherwise produce on every test.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSendMessage, Env } from "../../src/env";
import { sendBeat, type BeatMail } from "../../src/email/outbound";
import { scanProse, type MentionScan } from "../../src/lore/mentions";
import { world } from "../lore/fixtures";

/**
 * `scanProse` is pure, so "how many times was it called" is invisible in its
 * output — a spy is the only seam that can see it, and `#fanOut`'s scan-once
 * property is otherwise asserted nowhere.
 *
 * The spy wraps the *real* implementation, so every other test in this file
 * still exercises production behaviour; only a call count is added.
 */
vi.mock("../../src/lore/mentions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lore/mentions")>();
  return { ...actual, scanProse: vi.fn(actual.scanProse) };
});

const runtime = runtimeEnv as unknown as Env;

// Column-for-column with `migrations/0001_init.sql`, FK constraints dropped as
// the rest of this repo's test schemas already do. The UNIQUE index on
// `reply_bindings.message_id` is deliberately not recreated; the send stub
// below hands back a distinct id per call instead, which is both closer to
// reality and keeps a multi-send test from silently losing its second insert.
//
// Everything below `reply_bindings` is for the fan-out test at the end of this
// file, which drives a real `CampaignDO` through a real tick. That path writes
// `events`/`entities`/`beats` and reads `memberships`/`players`, all with
// swallowed failures — so an undeclared table there would not fail a test, it
// would quietly stop covering the write while printing plausible-looking
// "projection failed" noise.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS reply_bindings (code TEXT PRIMARY KEY, message_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL, player_id TEXT NOT NULL, tick INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (campaign_id TEXT NOT NULL, player_id TEXT NOT NULL,
  character_id TEXT NOT NULL, character_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player',
  joined_at TEXT NOT NULL, PRIMARY KEY (campaign_id, player_id));
CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, cadence TEXT NOT NULL, quorum_fraction REAL NOT NULL DEFAULT 0.5,
  tick INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER, public_chronicle INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities (campaign_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (campaign_id, entity_id));
CREATE TABLE IF NOT EXISTS events (campaign_id TEXT NOT NULL, event_id TEXT NOT NULL,
  tick INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, region_id TEXT,
  summary TEXT NOT NULL, significance INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  target_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, event_id));
CREATE TABLE IF NOT EXISTS beats (campaign_id TEXT NOT NULL, tick INTEGER NOT NULL,
  prose TEXT NOT NULL, situation TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, PRIMARY KEY (campaign_id, tick));
`;

const CAMPAIGN = "cmp_1";
const SLUG = "demo";
const ORIGIN = "https://play.example";

const sent: EmailSendMessage[] = [];

const env = {
  ...runtime,
  DB: runtime.DB,
  MAIL_DOMAIN: "mail.example",
  PUBLIC_ORIGIN: ORIGIN,
  EMAIL: {
    async send(message: EmailSendMessage) {
      sent.push(message);
      return { messageId: `<assigned-${sent.length}@mail.example>` };
    },
  },
} as unknown as Env;

function beat(overrides: Partial<BeatMail> = {}): BeatMail {
  return {
    campaignId: CAMPAIGN,
    campaignSlug: SLUG,
    campaignName: "Ashfall",
    tick: 7,
    playerId: "plr_1",
    toEmail: "player@example.com",
    headline: "The envoy",
    prose: "Nothing recognisable happened at all.",
    prompt: "What do you do?",
    ...overrides,
  };
}

/** The two parts of the nth message this test has sent. */
function parts(index = 0): { text: string; html: string } {
  const message = sent[index];
  if (!message) throw new Error(`no message at index ${index}`);
  return { text: message.text, html: message.html ?? "" };
}

/**
 * True when an `<a>` is opened inside one paragraph and closed inside another.
 *
 * Walks the tag stream rather than parsing: any paragraph boundary seen while
 * an anchor is open is a straddle.
 */
function anchorStraddlesParagraph(html: string): boolean {
  let open = false;
  for (const token of html.match(/<a\s[^>]*>|<\/a>|<\/p>|<p[\s>]/g) ?? []) {
    if (token.startsWith("<a")) open = true;
    else if (token === "</a>") open = false;
    else if (open) return true;
  }
  return false;
}

// File-level, outside every `describe`, so any one test can be run alone with
// `-t` and still find its tables.
beforeAll(async () => {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await runtime.DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  sent.length = 0;
  await runtime.DB.prepare("DELETE FROM reply_bindings WHERE campaign_id = ?").bind(CAMPAIGN).run();
});

describe("beat mail — linked mentions", () => {
  it("links the first mention of an entity to its dossier", async () => {
    const prose = "The Ashen Coil sent word to Vresford.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { html } = parts();
    expect(html).toContain(`href="${ORIGIN}/c/demo/who/fac_0"`);
    expect(html).toContain(`href="${ORIGIN}/c/demo/who/stl_0"`);
    expect(html).toContain(">The Ashen Coil</a>");
    expect(html).toContain(">Vresford</a>");
  });

  it("links only the first occurrence, leaving the second as plain prose", async () => {
    const prose = "Vresford burned. Vresford wept.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { html } = parts();
    // One anchor in the prose plus one in the who's-who list; the repeat is not
    // linked, so the body itself carries exactly one.
    const body = html.slice(0, html.indexOf("<hr"));
    expect(body.match(/<a /g)).toHaveLength(1);
    expect(body).toContain("Vresford wept.");
  });

  it("uses the quiet reference style, and every href points at PUBLIC_ORIGIN", async () => {
    const prose = "The Ashen Coil sent word to Vresford.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { html } = parts();

    // The colour is stated explicitly rather than inherited: Outlook desktop's
    // Word rendering engine ignores `color:inherit` and would fall back to
    // default hyperlink blue on all eight mentions — exactly the link-density
    // look the cap of 8 exists to avoid.
    expect(html).toContain(
      "color:#1c1a17;text-decoration:underline;" +
        "text-decoration-color:#c9b9a5;text-underline-offset:2px",
    );
    expect(html).not.toContain("color:inherit");

    // Deliverability: every href in the message points at PUBLIC_ORIGIN, and
    // every dossier anchor's visible text is the entity name, not a URL.
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.startsWith(`${ORIGIN}/`)).toBe(true);

    const labels = [...html.matchAll(/<a href="[^"]*\/who\/[^"]*"[^>]*>([^<]*)<\/a>/g)].map(
      (m) => m[1]!,
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(["The Ashen Coil", "Vresford"]).toContain(label);
    }
  });

  it("anchors the prose's own casing while the who's-who uses the canonical name", async () => {
    // Deliberate, and the one place anchor text is not the canonical name:
    // `scanProse` slices the matched span out of the prose so the sentence
    // still reads. A reader seeing "word came from vresford" must not find
    // "Vresford" spliced mid-sentence. It is still not a display/href
    // mismatch — the label is the same entity, differing only in case, and the
    // who's-who block below carries the canonical spelling.
    const prose = "word came from vresford at dusk.";
    const scan = scanProse(prose, world());
    expect(scan.mentions.map((m) => m.name)).toEqual(["Vresford"]);

    await sendBeat(env, beat({ prose, scan }));
    const { text, html } = parts();

    const body = html.slice(0, html.indexOf("<hr"));
    expect(body).toContain(">vresford</a>");
    expect(body).not.toContain(">Vresford</a>");

    const listHtml = html.slice(html.indexOf("Who's who in this turn"));
    expect(listHtml).toContain(">Vresford</a>");
    expect(text).toContain("  · Vresford — a town in Thornreach");

    // Same entity, same destination, whichever casing was rendered.
    expect(html.match(new RegExp(`href="${ORIGIN}/c/demo/who/stl_0"`, "g"))).toHaveLength(2);
  });

  it("preserves paragraph breaks around links", async () => {
    const prose = "The Ashen Coil moved.\n\nVresford did not.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { html } = parts();
    expect(html.match(/<p style="margin:0 0 1em">/g)).toHaveLength(2);
    // The anchor must land inside its own paragraph, not straddle the split.
    expect(html).toContain(`<p style="margin:0 0 1em"><a href="${ORIGIN}/c/demo/who/fac_0"`);
  });

  it("keeps a single newline as a <br> inside a linked paragraph", async () => {
    const prose = "The Ashen Coil moved.\nVresford did not.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { html } = parts();
    expect(html.match(/<p style="margin:0 0 1em">/g)).toHaveLength(1);
    expect(html).toContain("<br>");
  });

  it("never opens an anchor in one paragraph and closes it in the next", async () => {
    // The renderer assembles linked HTML first and splits it into paragraphs
    // on `\n{2,}` afterwards. That is only sound because an anchor can never
    // contain a newline — a guarantee enforced in `candidates()`, which
    // refuses to make a name with a line break linkable at all. Without it an
    // entity named "Ashen\n\nCoil" really does produce
    // `<p>Then <a …>Ashen</p><p>Coil</a> arrived.</p>`.
    for (const name of ["Ashen\n\nCoil", "Ashen\nCoil"]) {
      const broken = world();
      broken.factions.fac_0!.name = name;
      const prose = `Then ${name} arrived.`;
      sent.length = 0;
      await sendBeat(env, beat({ prose, scan: scanProse(prose, broken) }));
      const { html } = parts();
      expect(anchorStraddlesParagraph(html)).toBe(false);
      // The prose still renders in full; only the link is withheld.
      expect(html).toContain("arrived.");
      expect(html).not.toContain("/who/fac_0");
    }
  });

  it("has a straddle probe that actually detects a straddle", () => {
    // Guards the test above from passing vacuously: the probe must report true
    // for the exact shape the guarantee exists to prevent.
    expect(
      anchorStraddlesParagraph(
        `<p style="margin:0 0 1em">Then <a href="x">Ashen</p>\n<p style="margin:0 0 1em">Coil</a> arrived.</p>`,
      ),
    ).toBe(true);
    expect(
      anchorStraddlesParagraph(
        `<p style="margin:0 0 1em">Then <a href="x">Ashen Coil</a> arrived.</p>`,
      ),
    ).toBe(false);
  });
});

describe("beat mail — who's who", () => {
  it("lists who's who in both parts", async () => {
    const prose = "The Ashen Coil sent word.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { text, html } = parts();

    expect(text).toContain("Who's who in this turn:");
    expect(text).toContain("The Ashen Coil — cult · seated at Vresford");
    expect(text).toContain(`${ORIGIN}/c/demo/who/fac_0`);

    expect(html).toContain("Who's who in this turn");
    expect(html).toContain(`<a href="${ORIGIN}/c/demo/who/fac_0"`);
    expect(html).toContain("cult · seated at Vresford");
  });

  it("uses the same list and order in both parts", async () => {
    const prose = "The Ashen Coil sent word to Vresford, and Sera Coldwater rode for Thornreach.";
    const scan = scanProse(prose, world());
    await sendBeat(env, beat({ prose, scan }));
    const { text, html } = parts();

    const order = scan.mentions.map((m) => m.id);
    expect(order.length).toBeGreaterThan(2);

    const block = text.slice(text.indexOf("Who's who in this turn:"));
    const fromText = [...block.matchAll(/\/who\/([a-z_0-9]+)/g)].map((m) => m[1]!);
    const listHtml = html.slice(html.indexOf("Who's who in this turn"));
    const fromHtml = [...listHtml.matchAll(/\/who\/([a-z_0-9]+)/g)].map((m) => m[1]!);

    expect(fromText).toEqual(order);
    expect(fromHtml).toEqual(order);
  });

  it("sits below the prompt and the reply line in both parts", async () => {
    const prose = "The Ashen Coil sent word.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { text, html } = parts();

    expect(text.indexOf("Who's who")).toBeGreaterThan(text.indexOf("What do you do?"));
    expect(text.indexOf("Who's who")).toBeGreaterThan(text.indexOf("Just reply to this email"));
    expect(html.indexOf("Who's who")).toBeGreaterThan(html.indexOf("What do you do?"));
    expect(html.indexOf("Who's who")).toBeGreaterThan(html.indexOf("Just reply to this email"));
    // And below the one loud link, so nothing competes with the call to action.
    expect(html.indexOf("Who's who")).toBeGreaterThan(html.indexOf("Read the chronicle"));
  });

  it("omits the dash and description when a blurb is empty", async () => {
    // `blurbFor` answers "" for a row that parsed but is not the shape it
    // claims — `entities.data` is TEXT, so this is a state that really occurs.
    // An empty blurb must lose the clause, not render a dangling " — ".
    const malformed = world();
    (malformed.factions.fac_0 as unknown as Record<string, unknown>).kind = "";
    const prose = "The Ashen Coil sent word.";
    const scan = scanProse(prose, malformed);
    expect(scan.mentions[0]!.blurb).toBe("");

    await sendBeat(env, beat({ prose, scan }));
    const { text, html } = parts();

    expect(text).toContain(`  · The Ashen Coil\n    ${ORIGIN}/c/demo/who/fac_0`);
    expect(text).not.toContain("The Ashen Coil —");
    expect(html).toContain(">The Ashen Coil</a></li>");
    expect(html).not.toContain("The Ashen Coil</a> —");
  });
});

describe("beat mail — escaping", () => {
  it("escapes prose around a link", async () => {
    const prose = "The Ashen Coil said <b>no</b> & left.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { html } = parts();
    expect(html).toContain("&lt;b&gt;no&lt;/b&gt; &amp; left.");
    expect(html).not.toContain("<b>no</b>");
    expect(html).toContain("/who/fac_0");
  });

  it("escapes a hostile entity name in the anchor and in the who's-who list", async () => {
    const hostile = world();
    hostile.factions.fac_0!.name = "<script>alert(1)</script>";
    const prose = "Then <script>alert(1)</script> arrived.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, hostile) }));
    const { text, html } = parts();

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Twice: once as the linked mention, once in the who's-who list.
    expect(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g)).toHaveLength(2);

    // The text part is text/plain. A tag there is literal text, not markup, and
    // escaping it would both mangle what the DM wrote and break byte-identity —
    // prose reaches the text part raw today and must keep doing so. What has to
    // hold is that this feature introduces no markup and no entity escaping
    // there at all.
    expect(text).not.toMatch(/<a\s|<\/a>|<li|<ul|<p\s|<br>/);
    expect(text).not.toContain("&lt;");
    expect(text).not.toContain("&amp;");
    expect(text).toContain("Then <script>alert(1)</script> arrived.");
  });

  it("escapes a hostile campaign slug in every href it builds", async () => {
    const prose = "The Ashen Coil sent word.";
    await sendBeat(
      env,
      beat({ prose, campaignSlug: 'a"b', scan: scanProse(prose, world()) }),
    );
    const { html } = parts();
    expect(html).not.toContain('href="https://play.example/c/a"b');
    expect(html).toContain("/c/a%22b/who/fac_0");
  });
});

describe("beat mail — zero mentions is byte-identical", () => {
  /**
   * The safety property. A beat with no recognised names must produce exactly
   * the bytes it produced before linking existed, through every route that can
   * legitimately reach the renderer:
   *
   *   - no scan at all (a caller that never opted in)
   *   - a scan that matched nothing (one text segment — what `scanProse`
   *     actually returns for unrecognised prose, and also its malformed-state
   *     fallback)
   *   - a scan with no segments at all (empty prose)
   */
  it("matches the no-scan baseline for every zero-mention scan shape", async () => {
    const prose = "Nothing recognisable happened at all.";

    await sendBeat(env, beat({ prose }));
    const baseline = parts(0);

    // Not vacuous: the baseline is real, populated output.
    expect(baseline.html).toContain("Nothing recognisable happened at all.");
    expect(baseline.text).toContain("What do you do?");
    expect(baseline.html.length).toBeGreaterThan(200);

    const matchedNothing = scanProse(prose, world());
    expect(matchedNothing.mentions).toEqual([]);
    expect(matchedNothing.segments).toEqual([{ type: "text", value: prose }]);
    await sendBeat(env, beat({ prose, scan: matchedNothing }));
    expect(parts(1)).toEqual(baseline);

    const noSegments: MentionScan = { mentions: [], segments: [] };
    await sendBeat(env, beat({ prose, scan: noSegments }));
    expect(parts(2)).toEqual(baseline);

    expect(baseline.html).not.toContain("Who's who");
    expect(baseline.text).not.toContain("Who's who");
  });

  it("is a comparison that can fail — one real mention changes the bytes", async () => {
    // Proves the assertion above is not vacuous: the same helper, the same
    // comparison, a scan that finds something, and the parts differ.
    const plain = "Nothing recognisable happened at all.";
    await sendBeat(env, beat({ prose: plain }));
    const baseline = parts(0);

    const prose = "The Ashen Coil sent word.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    expect(parts(1)).not.toEqual(baseline);
    expect(parts(1).html).toContain("Who's who");
  });

  it("keeps recap and auto-action blocks unchanged when nothing is recognised", async () => {
    const prose = "Nothing recognisable happened at all.";
    const extras = { recap: ["A cart lost a wheel."], actedForYou: "keep watch" };

    await sendBeat(env, beat({ prose, ...extras }));
    const baseline = parts(0);

    await sendBeat(env, beat({ prose, ...extras, scan: scanProse(prose, world()) }));
    expect(parts(1)).toEqual(baseline);
    expect(baseline.html).toContain("While you were away");
  });
});

describe("beat mail — existing send behaviour is untouched", () => {
  it("captures the assigned Message-ID and writes the reply binding", async () => {
    const prose = "The Ashen Coil sent word.";
    const result = await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    expect(result).not.toBeNull();

    const row = await runtime.DB.prepare(
      "SELECT message_id, campaign_id, player_id, tick FROM reply_bindings WHERE code = ?",
    )
      .bind(result!.code)
      .first<{ message_id: string; campaign_id: string; player_id: string; tick: number }>();

    expect(row?.message_id).toBe("assigned-1@mail.example");
    expect(row?.campaign_id).toBe(CAMPAIGN);
    expect(row?.player_id).toBe("plr_1");
    expect(row?.tick).toBe(7);
  });

  it("retries once and still links the mention on the second attempt", async () => {
    let attempts = 0;
    const flaky = {
      ...env,
      EMAIL: {
        async send(message: EmailSendMessage) {
          attempts++;
          if (attempts === 1) throw new Error("upstream blip");
          sent.push(message);
          return { messageId: `<assigned-${sent.length}@mail.example>` };
        },
      },
    } as unknown as Env;

    const prose = "The Ashen Coil sent word.";
    const result = await sendBeat(flaky, beat({ prose, scan: scanProse(prose, world()) }));
    expect(attempts).toBe(2);
    expect(result).not.toBeNull();
    expect(parts().html).toContain("/who/fac_0");
  });
});

/**
 * The tick scans once, not once per player.
 *
 * `#fanOut` builds the scan above its member loop because every member gets
 * the same prose. That was a comment and nothing else — a refactor sliding the
 * call inside the loop would ship green, quietly turning one pure pass into
 * one per player on the campaign's hottest path.
 *
 * Nothing short of a real `CampaignDO` covers it: the property lives in the
 * placement of one statement inside a private method, and `scanProse` is pure,
 * so its output cannot betray how often it ran. This drives `init` -> `join`
 * -> `resolveTick` -> `#fanOut` -> `sendBeat` for real, against real D1
 * membership rows and miniflare's `send_email` binding.
 */
describe("beat mail — the tick scans once per tick, not once per player", () => {
  const FANOUT_CAMPAIGN = "cmp_fanout_scan_once";
  const MEMBERS = 4;

  it(
    "runs scanProse exactly once while mailing every member",
    { timeout: 30_000 },
    async () => {
      const stub = runtime.CAMPAIGN.get(runtime.CAMPAIGN.idFromName(FANOUT_CAMPAIGN));
      await stub.init({
        campaignId: FANOUT_CAMPAIGN,
        slug: "fanout",
        name: "Fanout",
        cadence: "weekly",
        // Only the roster is needed, not a deep pre-play history.
        historyYears: 1,
      });

      const joinedAt = new Date().toISOString();
      for (let i = 1; i <= MEMBERS; i++) {
        const playerId = `plr_fan_${i}`;
        const joined = await stub.join(playerId, `Tester ${i}`, "scout");
        // `join` writes the character into the DO's world; `#fanOut` reads the
        // roster from D1, so the membership rows have to exist there too.
        await runtime.DB.prepare(
          "INSERT OR REPLACE INTO players (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
        )
          .bind(playerId, `fan${i}@example.test`, `Tester ${i}`, joinedAt)
          .run();
        await runtime.DB.prepare(
          `INSERT OR REPLACE INTO memberships
             (campaign_id, player_id, character_id, character_name, role, joined_at)
           VALUES (?, ?, ?, ?, 'player', ?)`,
        )
          .bind(FANOUT_CAMPAIGN, playerId, joined.characterId, joined.characterName, joinedAt)
          .run();
      }

      // Count only what the tick does, not what the rest of this file did.
      vi.mocked(scanProse).mockClear();
      await stub.resolveTick("deadline");

      // `#fanOut` is detached through `ctx.waitUntil`, so `resolveTick`
      // returning does not mean the mail has gone out. One `reply_bindings`
      // row is written per successful send, so that count is the loop's
      // iteration count observed from outside.
      const deadline = Date.now() + 20_000;
      let mailed = 0;
      while (Date.now() < deadline) {
        const row = await runtime.DB.prepare(
          "SELECT COUNT(*) AS n FROM reply_bindings WHERE campaign_id = ?",
        )
          .bind(FANOUT_CAMPAIGN)
          .first<{ n: number }>();
        mailed = row?.n ?? 0;
        if (mailed >= MEMBERS) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Both halves matter. Without the first, "one call" would also be true
      // of a fan-out that mailed nobody; without the second, the property
      // under test is not asserted at all. A call moved inside the loop makes
      // this 4.
      expect(mailed).toBe(MEMBERS);
      expect(vi.mocked(scanProse).mock.calls).toHaveLength(1);
    },
  );
});
