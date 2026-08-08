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
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailSendMessage, Env } from "../../src/env";
import { sendBeat, type BeatMail } from "../../src/email/outbound";
import { scanProse, type MentionScan } from "../../src/lore/mentions";
import { world } from "../lore/fixtures";

const runtime = runtimeEnv as unknown as Env;

// Column-for-column with `migrations/0001_init.sql:115`, FK constraints
// dropped as the rest of this repo's test schemas already do. The UNIQUE index
// on `message_id` is deliberately not recreated; the send stub below hands back
// a distinct id per call instead, which is both closer to reality and keeps a
// multi-send test from silently losing its second insert.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS reply_bindings (code TEXT PRIMARY KEY, message_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL, player_id TEXT NOT NULL, tick INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
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

  it("uses the quiet reference style and never a display/href mismatch", async () => {
    const prose = "The Ashen Coil sent word to Vresford.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { html } = parts();

    expect(html).toContain(
      "color:inherit;text-decoration:underline;" +
        "text-decoration-color:#c9b9a5;text-underline-offset:2px",
    );

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
