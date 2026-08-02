import { beforeEach, describe, expect, it } from "vitest";
import { ACTION_SPECS, resolveAction } from "../../src/sim/actions";
import { EventLog } from "../../src/sim/events";
import { generateWorld } from "../../src/sim/genesis";
import { checkWorldInvariants } from "../../src/sim/invariants";
import { Rng, seedFrom } from "../../src/sim/prng";
import { ACTION_KINDS } from "../../src/sim/types";
import type { ActionKind, Character, PlayerAction, WorldState } from "../../src/sim/types";

function makeCharacter(state: WorldState, id = "chr_1"): Character {
  const town = Object.values(state.settlements).find((s) => !s.razed)!;
  const c: Character = {
    id,
    playerId: `player-${id}`,
    name: `Test ${id}`,
    concept: "a wanderer",
    attributes: { might: 3, wits: 3, grace: 3, spirit: 3 },
    skills: { arms: 2, insight: 2, persuasion: 2, survival: 2, barter: 2, lore: 2, care: 2, performance: 2 },
    tendencies: ["never leaves a debt unpaid"],
    bonds: {},
    renown: 10,
    conditions: [],
    locationId: town.id,
    presence: "present",
    lastActedTick: 0,
  };
  state.characters[id] = c;
  return c;
}

function action(over: Partial<PlayerAction> & { kind: ActionKind }): PlayerAction {
  return {
    id: "act-1",
    characterId: "chr_1",
    playerId: "player-chr_1",
    tick: 1,
    targetId: null,
    rawText: "I do the thing.",
    intent: "do the thing",
    via: "web",
    auto: false,
    ...over,
  };
}

describe("resolveAction", () => {
  let state: WorldState;

  beforeEach(() => {
    state = generateWorld("act-test", seedFrom("act-test", 0, "genesis"), { historyYears: 40 }).state;
    state.tick = 1;
    makeCharacter(state);
  });

  it("covers every declared action kind with a spec", () => {
    for (const kind of ACTION_KINDS) expect(ACTION_SPECS[kind]).toBeDefined();
  });

  it("is deterministic for the same seed", () => {
    const run = () => {
      const s = generateWorld("act-test", seedFrom("act-test", 0, "genesis"), { historyYears: 40 }).state;
      s.tick = 1;
      makeCharacter(s);
      const r = resolveAction(s, action({ kind: "perform" }), new Rng(seedFrom("x", 1)), new EventLog(1));
      return JSON.stringify({ outcome: r.outcome, roll: r.roll, state: s });
    };
    expect(run()).toBe(run());
  });

  it("always emits at least one event describing what happened", () => {
    for (const kind of ACTION_KINDS) {
      const log = new EventLog(1);
      const r = resolveAction(state, action({ kind }), new Rng(seedFrom(kind, 1)), log);
      expect(r.events.length).toBeGreaterThanOrEqual(1);
      expect(r.events[0]!.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it("preserves every world invariant across all kinds and outcomes", () => {
    for (const kind of ACTION_KINDS) {
      for (let seed = 0; seed < 60; seed++) {
        resolveAction(state, action({ kind }), new Rng(seedFrom(`${kind}`, seed)), new EventLog(1));
        expect(checkWorldInvariants(state)).toEqual([]);
      }
    }
  });

  it("records the player's own words verbatim on the event", () => {
    const log = new EventLog(1);
    const raw = "I put my hand on the door and ask, quietly, who is inside.";
    const r = resolveAction(state, action({ kind: "investigate", rawText: raw }), new Rng(1), log);
    expect(r.events[0]!.data.rawText).toBe(raw);
  });

  it("produces the full spread of outcomes when difficulty spans the range", () => {
    const threat = Object.values(state.threats).find((t) => !t.resolved)!;
    threat.revealed = true;
    const seen = new Set<string>();
    // Sweep both competence and difficulty; every tier must be reachable
    // somewhere in the space, or a tier is dead code.
    for (const stat of [1, 3, 5]) {
      state.characters.chr_1!.attributes = { might: stat, wits: stat, grace: stat, spirit: stat };
      state.characters.chr_1!.skills = { arms: stat - 1 };
      for (const severity of [10, 50, 95]) {
        threat.severity = severity;
        for (let seed = 0; seed < 120; seed++) {
          seen.add(
            resolveAction(state, action({ kind: "confront", targetId: threat.id }), new Rng(seedFrom("c", seed)), new EventLog(1)).outcome,
          );
          threat.severity = severity;
          threat.resolved = false;
        }
      }
    }
    expect([...seen].sort()).toEqual(
      ["critical_failure", "critical_success", "failure", "partial", "success"],
    );
  });

  it("does not let a capable character botch a routine task", () => {
    // Deliberate design property: whiffing on something easy is unfun and
    // makes the dice feel arbitrary. Competence should buy reliability.
    state.characters.chr_1!.attributes = { might: 4, wits: 4, grace: 4, spirit: 4 };
    state.characters.chr_1!.skills = { performance: 3 };
    for (let seed = 0; seed < 300; seed++) {
      const r = resolveAction(state, action({ kind: "perform" }), new Rng(seedFrom("easy", seed)), new EventLog(1));
      expect(r.outcome).not.toBe("critical_failure");
    }
  });

  it("gives a higher-skilled character better outcomes on the same roll", () => {
    const weak = { ...state.characters.chr_1!, attributes: { might: 1, wits: 1, grace: 1, spirit: 1 }, skills: {} };
    const strong = { ...state.characters.chr_1!, attributes: { might: 5, wits: 5, grace: 5, spirit: 5 }, skills: { arms: 5, persuasion: 5, insight: 5, survival: 5, barter: 5, lore: 5, care: 5, performance: 5 } };
    let weakWins = 0;
    let strongWins = 0;
    for (let seed = 0; seed < 200; seed++) {
      state.characters.chr_1 = weak;
      if (["critical_success", "success"].includes(resolveAction(state, action({ kind: "parley" }), new Rng(seedFrom("p", seed)), new EventLog(1)).outcome)) weakWins++;
      state.characters.chr_1 = strong;
      if (["critical_success", "success"].includes(resolveAction(state, action({ kind: "parley" }), new Rng(seedFrom("p", seed)), new EventLog(1)).outcome)) strongWins++;
    }
    expect(strongWins).toBeGreaterThan(weakWins);
  });

  describe("the no-penalty promise", () => {
    it("never lets an auto-action for a drifting player fail catastrophically", () => {
      for (const kind of ACTION_KINDS) {
        for (let seed = 0; seed < 200; seed++) {
          const r = resolveAction(
            state,
            action({ kind, auto: true, via: "auto" }),
            new Rng(seedFrom(`auto-${kind}`, seed)),
            new EventLog(1),
          );
          expect(r.outcome).not.toBe("critical_failure");
          expect(r.outcome).not.toBe("failure");
        }
      }
    });

    it("never applies a lasting condition from an auto-action", () => {
      const before = [...state.characters.chr_1!.conditions];
      for (let seed = 0; seed < 200; seed++) {
        resolveAction(state, action({ kind: "confront", auto: true, via: "auto" }), new Rng(seedFrom("ac", seed)), new EventLog(1));
      }
      expect(state.characters.chr_1!.conditions).toEqual(before);
    });

    it("never reduces renown below where an auto-action found it", () => {
      state.characters.chr_1!.renown = 40;
      for (let seed = 0; seed < 200; seed++) {
        const before = state.characters.chr_1!.renown;
        resolveAction(state, action({ kind: "confront", auto: true, via: "auto" }), new Rng(seedFrom("ar", seed)), new EventLog(1));
        expect(state.characters.chr_1!.renown).toBeGreaterThanOrEqual(before);
      }
    });

    it("marks auto-actions in the event so readers can tell it was not a real choice", () => {
      const log = new EventLog(1);
      const r = resolveAction(state, action({ kind: "guard", auto: true, via: "auto" }), new Rng(3), log);
      expect(r.events[0]!.data.auto).toBe(true);
    });
  });

  describe("targets", () => {
    it("tolerates a null target on every kind", () => {
      for (const kind of ACTION_KINDS) {
        expect(() =>
          resolveAction(state, action({ kind, targetId: null }), new Rng(seedFrom(kind, 9)), new EventLog(1)),
        ).not.toThrow();
      }
    });

    it("tolerates a target id that does not exist without corrupting the world", () => {
      for (const kind of ACTION_KINDS) {
        expect(() =>
          resolveAction(state, action({ kind, targetId: "nope_404" }), new Rng(seedFrom(kind, 11)), new EventLog(1)),
        ).not.toThrow();
        expect(checkWorldInvariants(state)).toEqual([]);
      }
    });

    it("shifts an NPC's attitude when parleyed with, and the NPC remembers", () => {
      const npc = Object.values(state.npcs).find((n) => n.alive)!;
      npc.attitudes = {};
      let moved = false;
      for (let seed = 0; seed < 80 && !moved; seed++) {
        resolveAction(state, action({ kind: "parley", targetId: npc.id }), new Rng(seedFrom("np", seed)), new EventLog(1));
        if (typeof npc.attitudes.chr_1 === "number" && npc.attitudes.chr_1 !== 0) moved = true;
      }
      expect(moved).toBe(true);
    });

    it("lets confronting a threat actually reduce it", () => {
      const threat = Object.values(state.threats).find((t) => !t.resolved)!;
      threat.severity = 70;
      threat.revealed = true;
      const before = threat.severity;
      let reduced = false;
      for (let seed = 0; seed < 120 && !reduced; seed++) {
        resolveAction(state, action({ kind: "confront", targetId: threat.id }), new Rng(seedFrom("th", seed)), new EventLog(1));
        if (threat.severity < before) reduced = true;
      }
      expect(reduced).toBe(true);
    });

    it("reveals a hidden threat on a successful scout", () => {
      const threat = Object.values(state.threats).find((t) => !t.resolved)!;
      threat.revealed = false;
      threat.severity = 20;
      let revealed = false;
      for (let seed = 0; seed < 150 && !revealed; seed++) {
        resolveAction(state, action({ kind: "scout", targetId: threat.id }), new Rng(seedFrom("sc", seed)), new EventLog(1));
        revealed = threat.revealed;
      }
      expect(revealed).toBe(true);
    });

    it("moves the character when travelling to an adjacent region", () => {
      const here = state.characters.chr_1!.locationId!;
      const region = state.settlements[here]?.regionId ?? here;
      const neighbor = state.regions[region]!.neighborIds[0]!;
      let moved = false;
      for (let seed = 0; seed < 120 && !moved; seed++) {
        resolveAction(state, action({ kind: "travel", targetId: neighbor }), new Rng(seedFrom("tv", seed)), new EventLog(1));
        moved = state.characters.chr_1!.locationId === neighbor;
      }
      expect(moved).toBe(true);
    });
  });

  it("throws a clear error when the acting character does not exist", () => {
    expect(() =>
      resolveAction(state, action({ kind: "aid", characterId: "chr_missing" }), new Rng(1), new EventLog(1)),
    ).toThrow(/chr_missing/);
  });
});
