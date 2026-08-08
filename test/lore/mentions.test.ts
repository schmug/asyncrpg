import { describe, expect, it } from "vitest";
import {
  blurbFor,
  dangerLabel,
  dossierPath,
  MAX_MENTIONS,
  scanProse,
  sizeLabel,
  type LinkableKind,
} from "../../src/lore/mentions";
import { THREAT_KINDS, type WorldState } from "../../src/sim/types";
import { world } from "./fixtures";

/**
 * A `WorldState` that has been through D1: `entities.data` is TEXT, so a row
 * parses into *some* object but is not guaranteed to be the shape. Casting is
 * how the read side actually receives this data.
 */
function loose(state: WorldState): Record<string, Record<string, unknown>> {
  return state as unknown as Record<string, Record<string, unknown>>;
}

/** The five kinds a `LinkableKind` may legitimately be. */
const KINDS = ["faction", "npc", "settlement", "region", "threat"] as const;

/**
 * Keys that resolve on `Object.prototype` and therefore survive a bare
 * `map[id]` lookup even though no such entity exists.
 */
const PROTOTYPE_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];

/**
 * Every raw field, agenda kind, and relation/attitude name that must never
 * reach a blurb (spec Global Constraints, §6).
 *
 * Each alternative is word-boundary anchored so this catches a field *name*
 * leaking as text without false-flagging the deliberately banded adjectives a
 * blurb is supposed to contain — `dangerous` is prose, `danger` is a field.
 * Compound agenda kinds are listed both raw and by stem, so a renderer that
 * humanises `court_favor` into `court favor` is caught too.
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

describe("banding labels", () => {
  it("bands population into prose with an article", () => {
    expect(sizeLabel(9000)).toBe("a city");
    expect(sizeLabel(5000)).toBe("a city");
    expect(sizeLabel(4999)).toBe("a town");
    expect(sizeLabel(1500)).toBe("a town");
    expect(sizeLabel(1499)).toBe("a village");
    expect(sizeLabel(400)).toBe("a village");
    expect(sizeLabel(399)).toBe("a hamlet");
    expect(sizeLabel(0)).toBe("a hamlet");
  });

  it("bands danger into prose", () => {
    expect(dangerLabel(90)).toBe("perilous");
    expect(dangerLabel(70)).toBe("perilous");
    expect(dangerLabel(69)).toBe("dangerous");
    expect(dangerLabel(45)).toBe("dangerous");
    expect(dangerLabel(44)).toBe("uneasy");
    expect(dangerLabel(20)).toBe("uneasy");
    expect(dangerLabel(19)).toBe("quiet");
    expect(dangerLabel(0)).toBe("quiet");
  });
});

describe("blurbs", () => {
  const w = world();

  it("describes a faction by kind and seat", () => {
    expect(blurbFor("faction", "fac_0", w)).toBe("cult · seated at Vresford");
  });

  it("describes a defunct faction without stats", () => {
    expect(blurbFor("faction", "fac_1", w)).toBe("broken and scattered");
  });

  it("describes a living npc by role, faction, and place", () => {
    expect(blurbFor("npc", "npc_0", w)).toBe("steward of The Ashen Coil, at Vresford");
  });

  it("marks a dead npc", () => {
    expect(blurbFor("npc", "npc_1", w)).toBe("outrider · died");
  });

  it("describes a settlement by size band and region", () => {
    expect(blurbFor("settlement", "stl_0", w)).toBe("a town in Thornreach");
  });

  it("describes a razed settlement as abandoned", () => {
    expect(blurbFor("settlement", "stl_1", w)).toBe("abandoned");
  });

  it("describes a region by terrain and danger band", () => {
    expect(blurbFor("region", "rgn_0", w)).toBe("forest · dangerous");
  });

  it("describes a threat with a grammatical phrase", () => {
    expect(blurbFor("threat", "thr_0", w)).toBe("a blight in Thornreach");
  });

  it("has a phrase for every threat kind the sim can produce", () => {
    // `THREAT_PHRASE` is typed `Record<ThreatKind, string>`, so an eighth kind
    // added to `src/sim/types.ts` is a compile error rather than a silent
    // "a danger in …". This test is the runtime half of that guarantee.
    const w2 = world();
    for (const kind of THREAT_KINDS) {
      w2.threats.thr_0!.kind = kind;
      const blurb = blurbFor("threat", "thr_0", w2);
      expect(blurb, kind).toMatch(/ in Thornreach$/);
      expect(blurb, kind).not.toMatch(/\bdanger\b/);
    }
  });

  it("describes nothing at all from an empty row, for every kind", () => {
    // The shape a half-written or pre-migration `entities.data` takes: it
    // parses, it is an object, it carries nothing. Every kind must decline,
    // because the alternative is not a thinner blurb — it is a fabricated one.
    const empty = world();
    const cases = [
      ["factions", "faction"],
      ["npcs", "npc"],
      ["settlements", "settlement"],
      ["regions", "region"],
      ["threats", "threat"],
    ] as const;
    for (const [bucket, kind] of cases) {
      const id = `${kind}_empty`;
      loose(empty)[bucket]![id] = {};
      expect(blurbFor(kind, id, empty), kind).toBe("");
    }
  });

  it("does not read a missing `alive` as dead", () => {
    // `!n.alive` is true for `undefined`, and "· died" is the single most
    // consequential claim this line can make about a person.
    const partial = world();
    loose(partial).npcs!.npc_partial = {
      id: "npc_partial",
      name: "Halden Vrey",
      role: "steward",
      factionId: "fac_0",
      locationId: "stl_0",
    };
    expect(blurbFor("npc", "npc_partial", partial)).toBe("");
  });

  it("does not read a missing population as a hamlet", () => {
    // `sizeLabel` bands from the bottom, so an absent number falls through
    // every threshold and reports the smallest settlement there is.
    const partial = world();
    loose(partial).settlements!.stl_partial = {
      id: "stl_partial",
      name: "Elsewhere",
      regionId: "rgn_0",
    };
    expect(blurbFor("settlement", "stl_partial", partial)).toBe("");
  });

  it("does not read a missing danger as quiet", () => {
    // Same failure as `population`, and this one defaults to the reassuring
    // answer: a region nobody has scored reads as safe.
    const partial = world();
    loose(partial).regions!.rgn_partial = { id: "rgn_partial", name: "Nowhere", terrain: "moor" };
    expect(blurbFor("region", "rgn_partial", partial)).toBe("");
  });

  it("still reports a genuine zero rather than treating it as absent", () => {
    // The guards test for presence, not truthiness: a real 0 is a real band.
    const zeroed = world();
    zeroed.settlements.stl_0!.population = 0;
    zeroed.regions.rgn_0!.danger = 0;
    expect(blurbFor("settlement", "stl_0", zeroed)).toBe("a hamlet in Thornreach");
    expect(blurbFor("region", "rgn_0", zeroed)).toBe("forest · quiet");
  });

  it("returns an empty string for a threat row with no recognisable kind", () => {
    // A row read back from `entities.data` can parse and still not be a Threat.
    const malformed = world();
    loose(malformed).threats!.thr_bad = { id: "thr_bad", name: "the Nameless", regionId: "rgn_0" };
    expect(blurbFor("threat", "thr_bad", malformed)).toBe("");
  });

  it("marks a resolved threat as ended", () => {
    // Spec §6 promises `· ended`; nothing exercised it until now.
    const ended = world();
    ended.threats.thr_0!.resolved = true;
    expect(blurbFor("threat", "thr_0", ended)).toBe("a blight in Thornreach · ended");
  });

  it("locates an npc who is standing in a region rather than a settlement", () => {
    // `locationId` may point at either bucket; the settlement lookup is only
    // tried first.
    const roaming = world();
    roaming.npcs.npc_0!.locationId = "rgn_0";
    expect(blurbFor("npc", "npc_0", roaming)).toBe("steward of The Ashen Coil, at Thornreach");
  });

  it("degrades rather than throwing when a reference dangles", () => {
    // A razed settlement or a purged faction can leave a stale id behind. The
    // blurb must lose the clause, not the page.
    const dangling = world();
    dangling.factions.fac_0!.seatSettlementId = "stl_gone";
    dangling.settlements.stl_0!.regionId = "rgn_gone";
    dangling.npcs.npc_0!.factionId = "fac_gone";
    dangling.npcs.npc_0!.locationId = "stl_gone";
    dangling.threats.thr_0!.regionId = "rgn_gone";

    expect(blurbFor("faction", "fac_0", dangling)).toBe("cult");
    expect(blurbFor("settlement", "stl_0", dangling)).toBe("a town");
    expect(blurbFor("npc", "npc_0", dangling)).toBe("steward");
    expect(blurbFor("threat", "thr_0", dangling)).toBe("a blight");
  });

  it("never leaks a raw 0-100 field or an agenda", () => {
    // Every blurb the module can currently produce, including the
    // defunct/dead/razed/resolved branches.
    const ended = world();
    ended.threats.thr_0!.resolved = true;

    const blurbs = [
      blurbFor("faction", "fac_0", w),
      blurbFor("faction", "fac_1", w),
      blurbFor("npc", "npc_0", w),
      blurbFor("npc", "npc_1", w),
      blurbFor("settlement", "stl_0", w),
      blurbFor("settlement", "stl_1", w),
      blurbFor("region", "rgn_0", w),
      blurbFor("threat", "thr_0", w),
      blurbFor("threat", "thr_0", ended),
    ];

    for (const blurb of blurbs) {
      // The assertion that actually catches a leaked value.
      expect(blurb, blurb).not.toMatch(/\d/);
      expect(blurb, blurb).not.toMatch(DISCLOSURE);
    }
  });

  it("returns an empty string for an unknown id rather than throwing", () => {
    expect(blurbFor("faction", "fac_nope", w)).toBe("");
  });

  it("returns an empty string for a kind outside the union", () => {
    // D1's `entities.kind` is untyped TEXT, so the next node casts a raw
    // column value straight to `LinkableKind`. `character` is a real value in
    // that column and is not linkable.
    for (const bogus of ["character", "", "Faction", "scene"]) {
      expect(blurbFor(bogus as LinkableKind, "chr_1", w), bogus).toBe("");
    }
  });

  it("does not resolve a prototype-chain key as an entity", () => {
    for (const kind of KINDS) {
      for (const id of PROTOTYPE_KEYS) {
        expect(blurbFor(kind, id, w), `${kind} / ${id}`).toBe("");
      }
    }
  });

  it("does not resolve a prototype-chain key as a nested reference", () => {
    const poisoned = world();
    poisoned.factions.fac_0!.seatSettlementId = "__proto__";
    poisoned.settlements.stl_0!.regionId = "constructor";
    poisoned.npcs.npc_0!.factionId = "constructor";
    poisoned.npcs.npc_0!.locationId = "__proto__";
    poisoned.threats.thr_0!.regionId = "constructor";

    expect(blurbFor("faction", "fac_0", poisoned)).toBe("cult");
    expect(blurbFor("settlement", "stl_0", poisoned)).toBe("a town");
    expect(blurbFor("npc", "npc_0", poisoned)).toBe("steward");
    expect(blurbFor("threat", "thr_0", poisoned)).toBe("a blight");
  });
});

describe("dossierPath", () => {
  it("builds an encoded path", () => {
    expect(dossierPath("demo", "fac_0")).toBe("/c/demo/who/fac_0");
  });

  it("encodes a slug with unusual characters", () => {
    expect(dossierPath("a b", "fac_0")).toBe("/c/a%20b/who/fac_0");
  });
});

/** Reassemble the prose from segments — must always be lossless. */
function rejoin(segments: { value: string }[]): string {
  return segments.map((s) => s.value).join("");
}

describe("scanProse", () => {
  const w = world();

  it("finds a faction and carries its blurb", () => {
    const { mentions } = scanProse("The Ashen Coil sent word.", w);
    expect(mentions).toEqual([
      { id: "fac_0", kind: "faction", name: "The Ashen Coil", blurb: "cult · seated at Vresford" },
    ]);
  });

  it("segments losslessly", () => {
    const prose = "The Ashen Coil sent word to Vresford at dusk.";
    const { segments } = scanProse(prose, w);
    expect(rejoin(segments)).toBe(prose);
    expect(segments.filter((s) => s.type === "mention").map((s) => s.value)).toEqual([
      "The Ashen Coil",
      "Vresford",
    ]);
  });

  it("prefers the longest name — House Vresk beats Vresk", () => {
    // Kelford is a settlement; House Vresk is a faction whose name contains no
    // other entity name. Use a world where one name is a prefix of another.
    const nested = world();
    nested.settlements.stl_0!.name = "Vresk";
    nested.factions.fac_1!.defunct = false;
    const { mentions } = scanProse("House Vresk rode out.", nested);
    expect(mentions.map((m) => m.id)).toEqual(["fac_1"]);
  });

  it("links only the first occurrence of an entity", () => {
    const { mentions, segments } = scanProse("Vresford burned. Vresford wept.", w);
    expect(mentions).toHaveLength(1);
    expect(segments.filter((s) => s.type === "mention")).toHaveLength(1);
    expect(rejoin(segments)).toBe("Vresford burned. Vresford wept.");
  });

  it("respects word boundaries", () => {
    expect(scanProse("The Vresfordian envoy arrived.", w).mentions).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(scanProse("word came from vresford.", w).mentions.map((m) => m.id)).toEqual(["stl_0"]);
  });

  it("never matches an unrevealed threat", () => {
    expect(scanProse("Word of the Kelth raiders spread.", w).mentions).toEqual([]);
  });

  it("still matches a dead npc", () => {
    expect(scanProse("They spoke of Bran One-Hand.", w).mentions.map((m) => m.id)).toEqual([
      "npc_1",
    ]);
  });

  // Eligibility is a rule per kind, and each rule needs its own witness —
  // "the faction case passes" is not evidence that regions are matched at all.

  it("still matches a defunct faction", () => {
    expect(scanProse("House Vresk rode out.", w).mentions).toEqual([
      { id: "fac_1", kind: "faction", name: "House Vresk", blurb: "broken and scattered" },
    ]);
  });

  it("still matches a razed settlement", () => {
    expect(scanProse("Smoke still rises over Kelford.", w).mentions).toEqual([
      { id: "stl_1", kind: "settlement", name: "Kelford", blurb: "abandoned" },
    ]);
  });

  it("matches a region", () => {
    expect(scanProse("Thornreach lay quiet.", w).mentions).toEqual([
      { id: "rgn_0", kind: "region", name: "Thornreach", blurb: "forest · dangerous" },
    ]);
  });

  it("matches a revealed threat", () => {
    expect(scanProse("The Grey Blight spread west.", w).mentions).toEqual([
      { id: "thr_0", kind: "threat", name: "the Grey Blight", blurb: "a blight in Thornreach" },
    ]);
  });

  it("matches a resolved threat that was never revealed", () => {
    // The `resolved` half of the `revealed || resolved` rule: a threat the
    // party ended before anyone named it is still safe to link, because the
    // projection already published it (`src/campaign-do.ts:660`).
    const ended = world();
    ended.threats.thr_1!.resolved = true;
    expect(scanProse("Word of the Kelth raiders spread.", ended).mentions).toEqual([
      {
        id: "thr_1",
        kind: "threat",
        name: "the Kelth raiders",
        blurb: "raiders in Thornreach · ended",
      },
    ]);
  });

  it("returns matched text raw and unescaped — escaping is the caller's job", () => {
    // Spec §11 asks for "an entity named <script>alert(1)</script> yields no
    // raw tag in output". That belongs to the *renderer*, not here: scanProse
    // deliberately returns raw text so the caller can escape each segment
    // individually and a match can never straddle an escape sequence. This
    // test pins the raw contract; the no-raw-tag assertion is enforced by the
    // HTML-escaping test in test/email/outbound.test.ts (Task 5).
    const scripted = world();
    scripted.settlements.stl_0!.name = "<script>alert(1)</script>";
    const prose = "They rode to <script>alert(1)</script> at dawn.";
    const { mentions, segments } = scanProse(prose, scripted);
    expect(mentions.map((m) => m.name)).toEqual(["<script>alert(1)</script>"]);
    expect(segments.filter((s) => s.type === "mention").map((s) => s.value)).toEqual([
      "<script>alert(1)</script>",
    ]);
    expect(rejoin(segments)).toBe(prose);
  });

  it("never matches a player character", () => {
    const withParty = world();
    withParty.characters.chr_p1 = {
      id: "chr_p1",
      playerId: "plr_1",
      name: "Alder Finch",
      concept: "scout",
      attributes: { might: 2, wits: 3, grace: 3, spirit: 2 },
      skills: {},
      tendencies: [],
      bonds: {},
      renown: 10,
      conditions: [],
      locationId: "stl_0",
      presence: "present",
      lastActedTick: 4,
    };
    expect(scanProse("Alder Finch went ahead.", withParty).mentions).toEqual([]);
  });

  it("ignores names shorter than four characters", () => {
    const shortName = world();
    shortName.settlements.stl_0!.name = "Ley";
    expect(scanProse("They reached Ley by dark.", shortName).mentions).toEqual([]);
  });

  it("caps at MAX_MENTIONS, keeping the earliest in the prose", () => {
    const many = world();
    for (let i = 0; i < 12; i++) {
      many.npcs[`npc_x${i}`] = {
        id: `npc_x${i}`,
        name: `Personage${i}`,
        role: "factor",
        factionId: null,
        locationId: null,
        alive: true,
        traits: [],
        attitudes: {},
        renown: 5,
      };
    }
    const prose = Array.from({ length: 12 }, (_, i) => `Personage${i}`).join(" met ");
    const { mentions, segments } = scanProse(prose, many);
    expect(mentions).toHaveLength(MAX_MENTIONS);
    expect(mentions[0]!.name).toBe("Personage0");
    expect(mentions.at(-1)!.name).toBe(`Personage${MAX_MENTIONS - 1}`);
    expect(rejoin(segments)).toBe(prose);
  });

  it("treats a name with regex metacharacters literally", () => {
    const odd = world();
    odd.settlements.stl_0!.name = "Vres.ford (Old)";
    expect(scanProse("They rode to Vres.ford (Old) at dawn.", odd).mentions.map((m) => m.id)).toEqual(
      ["stl_0"],
    );
    expect(scanProse("They rode to VresXford (Old) at dawn.", odd).mentions).toEqual([]);
  });

  it("returns empty for empty prose and for a world with nothing in it", () => {
    expect(scanProse("", w)).toEqual({ mentions: [], segments: [] });
    const bare = world();
    bare.factions = {};
    bare.npcs = {};
    bare.settlements = {};
    bare.regions = {};
    bare.threats = {};
    expect(scanProse("Nothing here.", bare).mentions).toEqual([]);
  });
});

/**
 * `scanProse` is total: it never throws, for any input.
 *
 * This is not defensive padding. `#fanOut` is invoked as
 * `this.#fanOut(...).catch((err) => console.error("fan-out failed", err))`
 * (`src/campaign-do.ts:519-521`), so a throw from here is swallowed and the
 * whole tick's beat email is lost — for every player in the campaign, on the
 * product's primary channel. Spec §10 promises that a detection failure
 * degrades to email byte-identical to today's, which requires the prose to
 * survive intact even when detection gives up entirely.
 *
 * Hence every case below asserts the lossless round-trip as well as the
 * absence of a throw: a scan that returns no segments would leave the caller
 * rebuilding the body from nothing.
 */
describe("scanProse totality", () => {
  const PROSE = "The Ashen Coil sent word to Vresford at dusk.";

  it("survives a WorldState with a bucket missing entirely", () => {
    const gutted = world();
    delete (gutted as Partial<WorldState>).threats;
    const scan = scanProse(PROSE, gutted);
    expect(rejoin(scan.segments)).toBe(PROSE);
    // The surviving buckets still work — degrade, don't disable.
    expect(scan.mentions.map((m) => m.id)).toEqual(["fac_0", "stl_0"]);
  });

  it("survives an own row with no name", () => {
    const nameless = world();
    loose(nameless).factions!.fac_bad = { id: "fac_bad" };
    const scan = scanProse(PROSE, nameless);
    expect(rejoin(scan.segments)).toBe(PROSE);
    expect(scan.mentions.map((m) => m.id)).toEqual(["fac_0", "stl_0"]);
  });

  it("survives an own row with a name but no kind", () => {
    // Passes `Object.hasOwn`, so the prototype guard does not catch it. This
    // is the shape a half-written or migrated `entities.data` row takes.
    const kindless = world();
    loose(kindless).factions!.fac_bad = { id: "fac_bad", name: "Hollow Writ" };
    const scan = scanProse("The Hollow Writ met at dusk.", kindless);
    expect(rejoin(scan.segments)).toBe("The Hollow Writ met at dusk.");
    expect(scan.mentions.map((m) => m.id)).toEqual(["fac_bad"]);
    // No usable identity facts, so no blurb — but a name, a link, and no throw.
    expect(scan.mentions[0]!.blurb).toBe("");
  });

  it("survives a null or empty state", () => {
    for (const state of [null, undefined, {}, [], "nope", 7]) {
      const scan = scanProse(PROSE, state as unknown as WorldState);
      expect(scan.mentions, String(state)).toEqual([]);
      expect(rejoin(scan.segments), String(state)).toBe(PROSE);
    }
  });

  it("survives an entity row that is not an object at all", () => {
    const junk = world();
    loose(junk).npcs!.npc_bad = null as unknown as Record<string, unknown>;
    loose(junk).settlements!.stl_bad = "Vresford" as unknown as Record<string, unknown>;
    const scan = scanProse(PROSE, junk);
    expect(rejoin(scan.segments)).toBe(PROSE);
  });

  it("never emits a mention without a linkable id", () => {
    // `mention.id` becomes a dossier URL. A row with no id would render
    // /c/<slug>/who/undefined — a permanent dead link in a sent email.
    const idless = world();
    // A name no other entity shares, and the longest in the world, so it is
    // tried first and cannot be masked by a well-formed row winning the span.
    loose(idless).settlements!.stl_bad = { name: "The Drowned Quarter" };
    const prose = "Word reached The Drowned Quarter from Vresford by dusk.";
    const scan = scanProse(prose, idless);

    // The well-formed row still matches, so this is not passing vacuously.
    expect(scan.mentions.map((m) => m.id)).toEqual(["stl_0"]);
    for (const m of scan.mentions) {
      expect(typeof m.id, JSON.stringify(m)).toBe("string");
      expect(m.id.length, JSON.stringify(m)).toBeGreaterThan(0);
    }
    expect(rejoin(scan.segments)).toBe(prose);
  });
});
