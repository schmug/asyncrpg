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
import { world } from "./fixtures";

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
