import { describe, expect, it } from "vitest";
import { joinCharacter } from "../../src/sim/character";
import { generateWorld } from "../../src/sim/genesis";
import { checkWorldInvariants } from "../../src/sim/invariants";
import { seedFrom } from "../../src/sim/prng";
import { DEFAULT_PRUNE_LIMITS, pruneWorld } from "../../src/sim/prune";
import { DEFAULT_CAMPAIGN_CONFIG, runTick } from "../../src/sim/tick";
import type { WorldState } from "../../src/sim/types";

function world(id = "prune"): WorldState {
  const { state } = generateWorld(id, seedFrom(id, 0, "genesis"), { historyYears: 80 });
  joinCharacter(state, { playerId: "p0", name: "Kestrel", seed: seedFrom(id, 0, "join") });
  return state;
}

describe("pruneWorld", () => {
  it("is a no-op on a small world", () => {
    const state = world();
    const before = JSON.stringify(state);
    pruneWorld(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("holds every invariant after pruning", () => {
    const state = world();
    for (let i = 0; i < 200; i++) {
      state.npcs[`npc_x${i}`] = {
        id: `npc_x${i}`,
        name: `Ghost ${i}`,
        role: "nobody",
        factionId: null,
        locationId: null,
        alive: false,
        traits: [],
        attitudes: {},
        renown: i % 50,
      };
    }
    pruneWorld(state);
    expect(checkWorldInvariants(state)).toEqual([]);
  });

  it("bounds NPC count and keeps the living", () => {
    const state = world();
    const livingBefore = Object.values(state.npcs).filter((n) => n.alive).length;
    for (let i = 0; i < 300; i++) {
      state.npcs[`npc_x${i}`] = {
        id: `npc_x${i}`, name: `Ghost ${i}`, role: "nobody", factionId: null,
        locationId: null, alive: false, traits: [], attitudes: {}, renown: 1,
      };
    }
    pruneWorld(state);
    expect(Object.keys(state.npcs).length).toBeLessThanOrEqual(DEFAULT_PRUNE_LIMITS.maxNpcs);
    expect(Object.values(state.npcs).filter((n) => n.alive).length).toBe(livingBefore);
  });

  it("keeps famous dead over forgotten dead", () => {
    const state = world();
    for (let i = 0; i < 200; i++) {
      state.npcs[`npc_x${i}`] = {
        id: `npc_x${i}`, name: `Ghost ${i}`, role: "nobody", factionId: null,
        locationId: null, alive: false, traits: [], attitudes: {}, renown: i < 5 ? 95 : 1,
      };
    }
    pruneWorld(state);
    for (let i = 0; i < 5; i++) expect(state.npcs[`npc_x${i}`]).toBeDefined();
  });

  it("never drops someone a player has a real bond with", () => {
    const state = world();
    const character = Object.values(state.characters)[0]!;
    character.bonds.npc_keepme = 60;
    state.npcs.npc_keepme = {
      id: "npc_keepme", name: "Owed A Debt", role: "nobody", factionId: null,
      locationId: null, alive: false, traits: [], attitudes: {}, renown: 0,
    };
    for (let i = 0; i < 300; i++) {
      state.npcs[`npc_x${i}`] = {
        id: `npc_x${i}`, name: `Ghost ${i}`, role: "nobody", factionId: null,
        locationId: null, alive: false, traits: [], attitudes: {}, renown: 0,
      };
    }
    pruneWorld(state);
    expect(state.npcs.npc_keepme).toBeDefined();
  });

  it("removing a faction cleans every reference to it", () => {
    const state = world();
    // Make a pile of defunct factions so pruning is forced to act.
    for (let i = 0; i < 40; i++) {
      const id = `fac_x${i}`;
      state.factions[id] = {
        id, name: `Dead House ${i}`, kind: "noble_house", power: 1, treasury: 0,
        seatSettlementId: null,
        agenda: { kind: "court_favor", targetId: null, progress: 0, urgency: 3 },
        relations: {}, defunct: true,
      };
      for (const other of Object.values(state.factions)) {
        if (other.id === id) continue;
        other.relations[id] = -5;
        state.factions[id]!.relations[other.id] = -5;
      }
    }
    // Point real state at one of them, so a sloppy removal would dangle.
    const victim = "fac_x0";
    const town = Object.values(state.settlements)[0]!;
    town.controllingFactionId = victim;
    const region = Object.values(state.regions)[0]!;
    region.controllingFactionId = victim;
    const npc = Object.values(state.npcs)[0]!;
    npc.factionId = victim;

    pruneWorld(state);

    expect(Object.keys(state.factions).length).toBeLessThanOrEqual(DEFAULT_PRUNE_LIMITS.maxFactions);
    expect(checkWorldInvariants(state)).toEqual([]);
  });

  it("never removes a living faction even when far over the cap", () => {
    const state = world();
    const livingBefore = Object.values(state.factions).filter((f) => !f.defunct).map((f) => f.id);
    for (let i = 0; i < 60; i++) {
      state.factions[`fac_x${i}`] = {
        id: `fac_x${i}`, name: `Dead House ${i}`, kind: "cult", power: 0, treasury: 0,
        seatSettlementId: null,
        agenda: { kind: "court_favor", targetId: null, progress: 0, urgency: 3 },
        relations: {}, defunct: true,
      };
    }
    pruneWorld(state);
    for (const id of livingBefore) expect(state.factions[id]).toBeDefined();
  });

  it("bounds threats and reassigns any agenda pointing at a removed one", () => {
    const state = world();
    for (let i = 0; i < 80; i++) {
      state.threats[`thr_x${i}`] = {
        id: `thr_x${i}`, name: `Old Trouble ${i}`, kind: "blight",
        regionId: Object.keys(state.regions)[0]!, severity: 0, growthRate: 0.5,
        revealed: true, resolved: true,
      };
    }
    const faction = Object.values(state.factions).find((f) => !f.defunct)!;
    faction.agenda = { kind: "hunt_threat", targetId: "thr_x0", progress: 10, urgency: 5 };

    pruneWorld(state);

    expect(Object.keys(state.threats).length).toBeLessThanOrEqual(DEFAULT_PRUNE_LIMITS.maxThreats);
    expect(checkWorldInvariants(state)).toEqual([]);
  });

  it("keeps state bounded across a long campaign", () => {
    const state = world("long");
    for (let t = 0; t < 1500; t++) {
      runTick(state, [], DEFAULT_CAMPAIGN_CONFIG);
      pruneWorld(state);
      const bad = checkWorldInvariants(state);
      if (bad.length) throw new Error(`tick ${t}: ${bad.join("; ")}`);
    }
    expect(Object.keys(state.npcs).length).toBeLessThanOrEqual(DEFAULT_PRUNE_LIMITS.maxNpcs);
    expect(Object.keys(state.threats).length).toBeLessThanOrEqual(DEFAULT_PRUNE_LIMITS.maxThreats);
    expect(Object.keys(state.factions).length).toBeLessThanOrEqual(DEFAULT_PRUNE_LIMITS.maxFactions);
    // The whole point: the serialized world must not grow without bound.
    expect(JSON.stringify(state).length).toBeLessThan(400_000);
  });
});
