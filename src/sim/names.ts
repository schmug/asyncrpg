/**
 * Deterministic procedural naming.
 *
 * No inference calls: names come from seeded syllable and word tables, so a
 * world can be generated (and regenerated identically) with the language model
 * entirely switched off. This is a Dwarf Fortress-lineage choice as much as a
 * cost one — names built from consistent morphology feel like they come from a
 * place, and a reader can learn to hear which faction a name belongs to.
 */

import type { Rng } from "./prng";
import type { FactionKind, Terrain, ThreatKind } from "./types";

const ONSET = [
  "b", "br", "d", "dr", "f", "g", "gr", "h", "k", "kr", "l", "m", "n", "p",
  "r", "s", "sk", "sl", "st", "t", "th", "tr", "v", "w", "y", "z",
];
const NUCLEUS = ["a", "e", "i", "o", "u", "ae", "ei", "ou", "ya", "au"];
const CODA = ["", "", "l", "n", "r", "s", "th", "ck", "ld", "rn", "st", "m", "g"];

function syllable(rng: Rng): string {
  return rng.pick(ONSET) + rng.pick(NUCLEUS) + rng.pick(CODA);
}

function word(rng: Rng, syllables: number): string {
  let out = "";
  for (let i = 0; i < syllables; i++) out += syllable(rng);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const TERRAIN_SUFFIX: Record<Terrain, string[]> = {
  coast: ["haven", "strand", "quay", "reach", "bight"],
  marsh: ["mire", "fen", "slough", "bog", "wash"],
  forest: ["wood", "hollow", "thicket", "grove", "shaw"],
  hills: ["barrow", "downs", "rise", "tor", "knoll"],
  mountains: ["crag", "pass", "spur", "horn", "scarp"],
  plains: ["field", "march", "expanse", "flats", "run"],
  waste: ["waste", "barrens", "scour", "ash", "dust"],
  underground: ["deep", "delve", "warren", "under", "hollows"],
};

const SETTLEMENT_SUFFIX = [
  "ford", "gate", "hold", "burgh", "stead", "cross", "watch", "market", "landing", "rest",
];

const FACTION_PATTERN: Record<FactionKind, (rng: Rng) => string> = {
  noble_house: (r) => `House ${word(r, 2)}`,
  merchant_guild: (r) => `${r.pick(["The", "The"])} ${word(r, 2)} ${r.pick(["Concern", "Consortium", "Exchange", "Company"])}`,
  cult: (r) => `${r.pick(["Order of", "Children of", "Choir of", "Hand of"])} the ${r.pick(["Drowned", "Silent", "Ashen", "Unbroken", "Patient", "Waking"])} ${r.pick(["Star", "Mother", "Coil", "Lamp", "Thorn", "Gate"])}`,
  warband: (r) => `The ${r.pick(["Iron", "Red", "Grey", "Black", "Broken", "Long"])} ${r.pick(["Spears", "Wolves", "Banners", "Riders", "Shields", "Hounds"])}`,
  order: (r) => `The ${r.pick(["Wardens", "Keepers", "Sentinels", "Lanterns", "Vigil"])} of ${word(r, 2)}`,
  syndicate: (r) => `The ${word(r, 1)} ${r.pick(["Ring", "Web", "Ledger", "Knot", "Tally"])}`,
};

const ROLES: Record<FactionKind, string[]> = {
  noble_house: ["heir", "steward", "castellan", "marshal", "chamberlain"],
  merchant_guild: ["factor", "assessor", "caravan master", "broker", "purser"],
  cult: ["hierophant", "acolyte", "confessor", "oracle", "warden of rites"],
  warband: ["war-chief", "outrider", "standard-bearer", "raid leader", "quartermaster"],
  order: ["commander", "sworn brother", "archivist", "lamplighter", "inquisitor"],
  syndicate: ["fixer", "tallyman", "knifehand", "smuggler", "informant"],
};

const TRAITS = [
  "keeps every promise", "holds grudges for decades", "cannot resist a wager",
  "speaks only in the morning", "is terrified of open water", "collects debts in favors",
  "never sits with their back to a door", "quotes scripture badly", "laughs at bad news",
  "trusts children and no one else", "counts coins while thinking", "will not lie outright",
  "is fiercely loyal to the dead", "believes in one prophecy", "hates their own name",
];

const THREAT_PATTERN: Record<ThreatKind, (rng: Rng) => string> = {
  blight: (r) => `the ${r.pick(["Grey", "Weeping", "Salt", "Iron"])} Blight`,
  raiders: (r) => `the ${word(r, 1)} raiders`,
  plague: (r) => `the ${r.pick(["Nine-Day", "Quiet", "Crimson", "Winter"])} Fever`,
  famine: (r) => `the ${r.pick(["Long", "Thin", "Hollow"])} Hunger`,
  haunting: (r) => `the ${r.pick(["Restless", "Unlit", "Counting", "Waiting"])} Dead of ${word(r, 2)}`,
  schism: (r) => `the ${word(r, 2)} Schism`,
  beast: (r) => `the beast of ${word(r, 2)}`,
};

const EPITHETS = [
  "the Patient", "the Unlucky", "One-Hand", "the Younger", "the Drowned",
  "Coldwater", "the Twice-Named", "Ashfoot", "the Merciful", "the Debtor",
];

/**
 * Names are drawn without replacement against a `used` set so a single world
 * never ships two identical place names — a small thing that badly breaks
 * immersion, and breaks entity lookup by name in the chronicle.
 */
function unique(used: Set<string>, make: () => string): string {
  for (let i = 0; i < 60; i++) {
    const candidate = make();
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // Deterministic disambiguation rather than an exception: a world with an
  // unlucky seed should still generate.
  let n = 2;
  let base = make();
  while (used.has(`${base} ${romanize(n)}`)) n++;
  const out = `${base} ${romanize(n)}`;
  used.add(out);
  return out;
}

function romanize(n: number): string {
  const table: [number, string][] = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  let rest = n;
  for (const [v, s] of table) while (rest >= v) { out += s; rest -= v; }
  return out;
}

export class NameForge {
  readonly #used: Set<string>;

  /**
   * Seed with every name already in the world. A forge created for a live tick
   * must know what genesis produced, or a successor NPC could be born sharing a
   * name with a settlement generated a hundred years earlier.
   */
  constructor(existing: Iterable<string> = []) {
    this.#used = new Set(existing);
  }

  region(rng: Rng, terrain: Terrain): string {
    return unique(this.#used, () => {
      const suffix = rng.pick(TERRAIN_SUFFIX[terrain]);
      return rng.chance(0.5)
        ? `${word(rng, 2)}${suffix}`
        : `The ${suffix.charAt(0).toUpperCase() + suffix.slice(1)} of ${word(rng, 2)}`;
    });
  }

  settlement(rng: Rng): string {
    return unique(this.#used, () =>
      rng.chance(0.7)
        ? `${word(rng, rng.int(1, 2))}${rng.pick(SETTLEMENT_SUFFIX)}`
        : `${word(rng, 2)}`,
    );
  }

  faction(rng: Rng, kind: FactionKind): string {
    return unique(this.#used, () => FACTION_PATTERN[kind](rng));
  }

  person(rng: Rng): string {
    return unique(this.#used, () => {
      const given = word(rng, rng.int(1, 2));
      return rng.chance(0.35) ? `${given} ${rng.pick(EPITHETS)}` : `${given} ${word(rng, 2)}`;
    });
  }

  threat(rng: Rng, kind: ThreatKind): string {
    return unique(this.#used, () => THREAT_PATTERN[kind](rng));
  }

  role(rng: Rng, kind: FactionKind): string {
    return rng.pick(ROLES[kind]);
  }

  traits(rng: Rng, count: number): string[] {
    return rng.shuffle(TRAITS).slice(0, count);
  }
}
